/**
 * 周复盘快照（REVIEW-002，DB §4.11.2/§4.11.3、SRS FR-061）。
 *
 * ## 为什么快照要落库并带版本
 *
 * 「上周的实际时长」这类事实一旦随输入变化而变，用户回看历史时看到的就不是当时
 * 的事实。所以快照**只存当时算出的值**、`snapshot_schema_version` 保证结构演进
 * 时可迁移（DB §4.11.3）。
 *
 * ## 取数口径（经项目总监裁定，2026-09-28）
 *
 * DB §4.11.3 只给字段形状、拍板 6 只定义「实际时长＝执行记录实际开始→完成」，
 * 因此四项口径由总监逐条裁定后写死在这里：
 *
 * 1. `planActual` **同源同窗**：计划与实际都取 `execution_logs`（`planned_minutes`
 *    与 `actual_minutes` 在同一行），窗口 = 用户时区下 `[weekStart, weekStart+7)`；
 *    同源同窗才构成拍板 6 要的「对比」。
 * 2. `taskStatusCounts` 同样是**本周执行记录的状态计数**（`minimum_completed`
 *    归入 `completed`）。
 * 3. `repeatedDeferrals` = 本周执行记录中 `status = 'deferred'` 按任务计数 ≥2 者
 *    （每次延期都会留下一条执行记录，见 DB §4.8「应用层追加一条 execution_logs」）。
 * 4. `expenseSummaries[].byCategory` 元素为 `{ categoryId, categoryName, totalMinor }`。
 */
import { InvariantError } from '@/shared/errors/app-error.ts';
import type { ExecutionStatus } from '../../execution/domain/execution-log.ts';

/** 当前快照结构版本（DB §4.11.2）。 */
export const WEEKLY_SNAPSHOT_SCHEMA_VERSION = 1;

/** 一周的天数（`weekStart` + 7 天即下周同一天）。 */
export const WEEK_LENGTH_DAYS = 7;

/** 四态计数的桶（FR-061 第 2 项的四枚 Badge）。 */
export const WEEKLY_STATUS_BUCKETS = ['completed', 'partial', 'deferred', 'skipped'] as const;

export type WeeklyStatusBucket = (typeof WEEKLY_STATUS_BUCKETS)[number];

/**
 * 执行状态 → 计数桶。
 *
 * `minimum_completed`（「最低版本完成」）在执行记录层单列（EXEC-001 冻结），但
 * FR-061 的四枚 Badge 只有「完成/部分完成/跳过/延期」——**最低版本完成属于完成**
 * （`countsAsCompleted` 的既有口径），不能让它从四态里消失。
 */
export function statusBucketOf(status: ExecutionStatus): WeeklyStatusBucket {
  return status === 'minimum_completed' ? 'completed' : status;
}

/** 计划/实际时长（分钟）。 */
export interface WeeklyPlanActual {
  readonly plannedMinutes: number;
  readonly actualMinutes: number;
}

/** 四态计数（四桶恒存在，缺者为 0——UI 是四枚固定 Badge，不是「有几项显示几项」）。 */
export type WeeklyTaskStatusCounts = Readonly<Record<WeeklyStatusBucket, number>>;

/** 重复延期任务（`deferCount` = 本周该任务被延期的次数）。 */
export interface WeeklyRepeatedDeferral {
  readonly taskId: string;
  readonly title: string;
  readonly deferCount: number;
}

/** 目标行动完成情况（`completed` / `total` 均为该目标下的行动数）。 */
export interface WeeklyGoalActions {
  readonly goalId: string;
  readonly goalName: string;
  readonly completed: number;
  readonly total: number;
}

/** 分类金额小计（金额为最小货币单位整数字符串）。 */
export interface WeeklyExpenseCategoryTotal {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly totalMinor: string;
}

/** 单币种开销摘要（跨币种分列、不合计——零混币合计）。 */
export interface WeeklyExpenseSummary {
  readonly currencyCode: string;
  readonly totalMinor: string;
  readonly byCategory: readonly WeeklyExpenseCategoryTotal[];
}

/**
 * 「事实」部分：与输入无关的统计，也是快照的落库内容（除币种开销外）。
 *
 * 开销摘要单列，因为它由 `GET /expense-summary` 的既有聚合产出（UI 规范 B2 第 6 项
 * 明文规定该数据源），而不是由本模块自己查一遍 `expenses`——同一份口径不做两遍。
 */
export interface WeeklyFacts {
  readonly planActual: WeeklyPlanActual;
  readonly taskStatusCounts: WeeklyTaskStatusCounts;
  readonly repeatedDeferrals: readonly WeeklyRepeatedDeferral[];
  readonly goalActions: readonly WeeklyGoalActions[];
}

/** 周复盘快照（schema v1）。 */
export interface WeeklySnapshot extends WeeklyFacts {
  readonly schemaVersion: number;
  readonly weekStart: string;
  readonly timezone: string;
  readonly expenseSummaries: readonly WeeklyExpenseSummary[];
}

/** 组装快照（纯函数：入参即全部输入，便于单测覆盖 schema 形状）。 */
export function buildWeeklySnapshot(input: {
  readonly weekStart: string;
  readonly timezone: string;
  readonly facts: WeeklyFacts;
  readonly expenseSummaries: readonly WeeklyExpenseSummary[];
}): WeeklySnapshot {
  return {
    schemaVersion: WEEKLY_SNAPSHOT_SCHEMA_VERSION,
    weekStart: input.weekStart,
    timezone: input.timezone,
    planActual: input.facts.planActual,
    taskStatusCounts: input.facts.taskStatusCounts,
    repeatedDeferrals: input.facts.repeatedDeferrals,
    goalActions: input.facts.goalActions,
    expenseSummaries: input.expenseSummaries,
  };
}

/** 四态桶的零值（列表查询无命中时也要给四枚 Badge 一个数）。 */
export const EMPTY_STATUS_COUNTS: WeeklyTaskStatusCounts = {
  completed: 0,
  partial: 0,
  deferred: 0,
  skipped: 0,
};

/**
 * 该周是否已结束（`weekStart + 7 <= 用户时区当日`，DB §4.11.2）。
 *
 * 纯字符串日历运算：与当前时刻无关的部分**不使用** `Date.now()` 的时区，
 * 调用方负责先把「此刻在用户时区的日历日」算出来。
 */
export function hasWeekEnded(weekStart: string, todayInUserTimeZone: string): boolean {
  const start = Date.parse(`${weekStart}T00:00:00Z`);
  const end = new Date(start + WEEK_LENGTH_DAYS * 86_400_000).toISOString().slice(0, 10);
  return end <= todayInUserTimeZone;
}

/** 从库里回读 `jsonb` 快照：结构不符即抛 `InvariantError`，不静默吞掉。 */
export function readWeeklySnapshot(value: unknown): WeeklySnapshot | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvariantError({ message: 'reviews.snapshot 不是对象' });
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== WEEKLY_SNAPSHOT_SCHEMA_VERSION) {
    throw new InvariantError({
      message: `reviews.snapshot 的 schemaVersion 不在本实现支持范围：${String(record.schemaVersion)}`,
    });
  }
  return value as WeeklySnapshot;
}
