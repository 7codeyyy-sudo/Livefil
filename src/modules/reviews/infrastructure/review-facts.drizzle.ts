/**
 * 复盘「事实」聚合的 Drizzle 实现（REVIEW-002，取数口径见 `weekly-snapshot.ts` 文件头）。
 *
 * ## 为什么这是只读端口
 *
 * 它跨 `execution_logs` / `tasks` / `goals` / `actions` 四张表做聚合，不拥有任何
 * 一张表的写路径——快照落库走 `ReviewRepository`。把「算什么」与「往哪写」分开，
 * 周复盘读取、周快照物化、日复盘摘要三条路径才能复用同一份取数口径。
 *
 * ## 三条纪律
 *
 * - **每条查询都带 `userId`**（含 JOIN 后的聚合），作用域谓词直接写在 where 里；
 * - **窗口在用户时区上切**：`execution_logs.occurred_at` 是瞬时，边界由
 *   `zonedToUtc` 把「用户时区的当地零点」换算成 UTC，绝不用固定偏移量；
 * - **金额/计数以字符串回读**：`SUM(...)` 在 pg 里返回 `bigint`，驱动以字符串给回，
 *   `Number()` 只用在分钟与行数上（二者都不可能触及 2^53）。
 */
import { and, asc, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import { actions, executionLogs, goals, tasks } from '@/infrastructure/database/schema.ts';
import { InvariantError } from '@/shared/errors/app-error.ts';

import { EXECUTION_STATUSES, type ExecutionStatus } from '../../execution/domain/execution-log.ts';
import { addDays, zonedToUtc } from '../../scheduling/domain/zoned-time.ts';
import type { DailyFacts, ReviewFactsRepository, WeekRange } from '../domain/review-repository.ts';
import {
  EMPTY_STATUS_COUNTS,
  statusBucketOf,
  type WeeklyFacts,
  type WeeklyGoalActions,
  type WeeklyPlanActual,
  type WeeklyRepeatedDeferral,
  type WeeklyTaskStatusCounts,
} from '../domain/weekly-snapshot.ts';

/** 状态分组的行形状（`SUM` / `COUNT` 都是 `bigint`，驱动以字符串回读）。 */
interface StatusAggregateRow {
  readonly status: string;
  readonly plannedMinutes: string | null;
  readonly actualMinutes: string | null;
  readonly logs: string;
}

/** 按状态分组的一次聚合（周窗口与日窗口共用同一段 SQL 文本）。 */
const statusAggregateSelection = {
  status: executionLogs.status,
  plannedMinutes: sql<string | null>`SUM(${executionLogs.plannedMinutes})`,
  actualMinutes: sql<string | null>`SUM(${executionLogs.actualMinutes})`,
  logs: sql<string>`COUNT(*)`,
};

/**
 * 日历窗口 → UTC 边界（左闭右开）。
 *
 * `days = 7` 即「一周」，`days = 1` 即「一个日历日」；`addDays` 是纯日历运算，
 * 因此跨月、跨年与 DST 边界都由它和 `zonedToUtc` 各管一半。
 */
function windowBounds(date: string, timezone: string, days: number): { start: Date; end: Date } {
  return {
    start: zonedToUtc(date, '00:00', timezone),
    end: zonedToUtc(addDays(date, days), '00:00', timezone),
  };
}

/**
 * 分组行 → 计划/实际时长与四态计数（纯累加，无 IO，便于单测口径）。
 *
 * 状态不在契约集合内说明有人绕过应用写库，明确报错而不是把它算进某个桶——
 * 静默归桶会让复盘数字与实际业务动作对不上，且无从排查。
 */
function accumulateStatuses(rows: readonly StatusAggregateRow[]): {
  readonly planActual: WeeklyPlanActual;
  readonly counts: WeeklyTaskStatusCounts;
} {
  const counts = { ...EMPTY_STATUS_COUNTS };
  let plannedMinutes = 0;
  let actualMinutes = 0;

  for (const row of rows) {
    if (!(EXECUTION_STATUSES as readonly string[]).includes(row.status)) {
      throw new InvariantError({
        message: `execution_logs.status 的取值不在契约集合内：${row.status}`,
      });
    }
    // `minimum_completed` 归入 completed（FR-061 的四枚 Badge 无第五格）。
    counts[statusBucketOf(row.status as ExecutionStatus)] += Number(row.logs);
    // 未填时长的行按 0 计入（SUM 的 NULL 表示「这一组一行都没填」）。
    plannedMinutes += row.plannedMinutes === null ? 0 : Number(row.plannedMinutes);
    actualMinutes += row.actualMinutes === null ? 0 : Number(row.actualMinutes);
  }

  return { planActual: { plannedMinutes, actualMinutes }, counts };
}

export function createReviewFactsRepository(db: Database): ReviewFactsRepository {
  return {
    async collectWeeklyFacts(userId: string, range: WeekRange): Promise<WeeklyFacts> {
      const { start, end } = windowBounds(range.weekStart, range.timezone, 7);

      const statusRows = await db
        .select(statusAggregateSelection)
        .from(executionLogs)
        .where(
          and(
            eq(executionLogs.userId, userId),
            gte(executionLogs.occurredAt, start),
            lt(executionLogs.occurredAt, end),
          ),
        )
        .groupBy(executionLogs.status);

      const { planActual, counts } = accumulateStatuses(statusRows);

      // 重复延期：本周 `deferred` 执行记录按任务计数 ≥2。inner join 顺带取标题；
      // 习惯打卡（action-only）没有 taskId，天然不进这份清单。
      const deferralRows = await db
        .select({
          taskId: executionLogs.taskId,
          title: tasks.title,
          deferCount: sql<string>`COUNT(*)`,
        })
        .from(executionLogs)
        .innerJoin(tasks, eq(executionLogs.taskId, tasks.id))
        .where(
          and(
            eq(executionLogs.userId, userId),
            eq(executionLogs.status, 'deferred'),
            gte(executionLogs.occurredAt, start),
            lt(executionLogs.occurredAt, end),
          ),
        )
        .groupBy(executionLogs.taskId, tasks.title)
        .having(sql`COUNT(*) >= 2`)
        .orderBy(desc(sql`COUNT(*)`), asc(tasks.title));

      const repeatedDeferrals: WeeklyRepeatedDeferral[] = [];
      for (const row of deferralRows) {
        // 驱动侧 taskId 仍可空（列可空），inner join 已保证实际有值——这里只是收窄类型。
        if (row.taskId === null) {
          continue;
        }
        repeatedDeferrals.push({
          taskId: row.taskId,
          title: row.title,
          deferCount: Number(row.deferCount),
        });
      }

      // 目标行动完成情况：只看**未软删**的行动（软删行动不再参与"本目标的行动数"）；
      // inner join 保证 `total >= 1`——没有行动的目标不进这张表，避免零行噪声。
      const goalRows = await db
        .select({
          goalId: goals.id,
          goalName: goals.name,
          total: sql<string>`COUNT(${actions.id})`,
          completed: sql<string>`COUNT(${actions.id}) FILTER (WHERE ${actions.status} = 'completed')`,
        })
        .from(goals)
        .innerJoin(actions, and(eq(actions.goalId, goals.id), isNull(actions.deletedAt)))
        .where(eq(goals.userId, userId))
        .groupBy(goals.id, goals.name)
        .orderBy(asc(goals.name), asc(goals.id));

      const goalActions: WeeklyGoalActions[] = goalRows.map((row) => ({
        goalId: row.goalId,
        goalName: row.goalName,
        completed: Number(row.completed),
        total: Number(row.total),
      }));

      return { planActual, taskStatusCounts: counts, repeatedDeferrals, goalActions };
    },

    async collectDailyFacts(userId: string, date: string, timezone: string): Promise<DailyFacts> {
      const { start, end } = windowBounds(date, timezone, 1);

      const rows = await db
        .select(statusAggregateSelection)
        .from(executionLogs)
        .where(
          and(
            eq(executionLogs.userId, userId),
            gte(executionLogs.occurredAt, start),
            lt(executionLogs.occurredAt, end),
          ),
        )
        .groupBy(executionLogs.status);

      const { planActual, counts } = accumulateStatuses(rows);

      // 「完成/未完成」是日复盘 B1 要点行要的两个数：完成＝completed（含最低版本
      // 完成），未完成＝其余三态之和。两者之和即当天全部执行记录数。
      return {
        planActual,
        completedCount: counts.completed,
        uncompletedCount: counts.partial + counts.deferred + counts.skipped,
      };
    },
  };
}
