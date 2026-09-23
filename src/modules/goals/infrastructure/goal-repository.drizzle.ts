/**
 * 目标与行动仓储的 Drizzle 实现（GOAL-001/002）。
 *
 * 两个工厂同居一文件：它们共享行映射与"目标下未删除行动"的查询口径，
 * 拆开只会复制这些私有细节。行动进度（`summarizeActionProgress`）是领域层
 * 的纯函数——这里只负责把行动行交给它。
 */
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import {
  actions,
  goals,
  tasks,
  type ActionRow,
  type GoalRow,
} from '@/infrastructure/database/schema.ts';
import { ConflictError, NotFoundError } from '@/shared/errors/app-error.ts';

import {
  ACTION_STATUSES,
  GOAL_STATUSES,
  assertResultMetric,
  type Action,
  type Goal,
  type GoalStatus,
} from '../domain/goal.ts';
import {
  summarizeActionProgress,
  type ActionRepository,
  type GoalDetail,
  type GoalPage,
  type GoalRepository,
} from '../domain/goal-repository.ts';

function isGoalStatus(value: string): value is GoalStatus {
  return (GOAL_STATUSES as readonly string[]).includes(value);
}

function isActionStatus(value: string): value is Action['status'] {
  return (ACTION_STATUSES as readonly string[]).includes(value);
}

function toGoal(row: GoalRow): Goal {
  if (!isGoalStatus(row.status)) {
    throw new Error(`goals.status 的取值不在契约集合内：${row.status}`);
  }
  return {
    id: row.id,
    userId: row.userId,
    lifeAreaId: row.lifeAreaId,
    name: row.name,
    reason: row.reason,
    status: row.status,
    startDate: row.startDate,
    targetDate: row.targetDate,
    resultMetric: row.resultMetric === null ? null : assertResultMetric(row.resultMetric),
    version: row.version,
  };
}

function toAction(row: ActionRow): Action {
  if (!isActionStatus(row.status)) {
    throw new Error(`actions.status 的取值不在契约集合内：${row.status}`);
  }
  return {
    id: row.id,
    userId: row.userId,
    goalId: row.goalId,
    name: row.name,
    minimumVersion: row.minimumVersion,
    targetFrequency: row.targetFrequency,
    estimatedMinutes: row.estimatedMinutes,
    status: row.status,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    version: row.version,
  };
}

/** 与 tasks 仓储同款的游标编解码（`(created_at, id)`，base64url，对客户端不透明）。 */
function encodeCursor(row: GoalRow): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { readonly time: Date; readonly id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      c?: unknown;
      i?: unknown;
    };
    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string') {
      return null;
    }
    const time = new Date(parsed.c);
    if (Number.isNaN(time.getTime())) {
      return null;
    }
    return { time, id: parsed.i };
  } catch {
    return null;
  }
}

export function createGoalRepository(db: Database): GoalRepository {
  return {
    async findById(userId, goalId) {
      const rows = await db
        .select()
        .from(goals)
        .where(and(eq(goals.userId, userId), eq(goals.id, goalId)))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toGoal(row);
    },

    async list(userId, options) {
      const conditions = [eq(goals.userId, userId)];
      if (options.status !== undefined) {
        conditions.push(eq(goals.status, options.status));
      }
      if (options.lifeAreaId !== undefined) {
        conditions.push(eq(goals.lifeAreaId, options.lifeAreaId));
      }
      const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
      if (cursor !== null) {
        conditions.push(sql`(${goals.createdAt}, ${goals.id}) < (${cursor.time}, ${cursor.id})`);
      }

      const rows = await db
        .select()
        .from(goals)
        // @user-scope-exempt: 作用域谓词在 conditions 数组首项，恒为 eq(goals.userId, userId)
        .where(and(...conditions))
        .orderBy(desc(goals.createdAt), desc(goals.id))
        .limit(options.limit + 1);

      const hasMore = rows.length > options.limit;
      const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
      const last = pageRows[pageRows.length - 1];
      const page: GoalPage = {
        items: pageRows.map(toGoal),
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
        hasMore,
      };
      return page;
    },

    async create(userId, input) {
      const rows = await db
        .insert(goals)
        .values({
          userId,
          name: input.name,
          lifeAreaId: input.lifeAreaId,
          reason: input.reason,
          targetDate: input.targetDate,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error('目标创建后未能读回');
      }
      return toGoal(row);
    },

    async update(userId, goalId, expectedVersion, patch) {
      const updates: Partial<GoalRow> = {};
      if (patch.name !== undefined) {
        updates.name = patch.name;
      }
      if (patch.reason !== undefined) {
        updates.reason = patch.reason;
      }
      if (patch.targetDate !== undefined) {
        updates.targetDate = patch.targetDate;
      }
      if (patch.status !== undefined) {
        updates.status = patch.status;
      }
      if (patch.resultMetric !== undefined) {
        // null 表示清空结果进度；对象则先过结构校验（jsonb 进库前收口）。
        updates.resultMetric = patch.resultMetric === null ? null : { ...patch.resultMetric };
      }

      const rows = await db
        .update(goals)
        .set({ ...updates, version: sql`${goals.version} + 1` })
        .where(
          and(eq(goals.userId, userId), eq(goals.id, goalId), eq(goals.version, expectedVersion)),
        )
        .returning();
      const row = rows[0];
      if (row === undefined) {
        const existing = await this.findById(userId, goalId);
        if (existing === null) {
          throw new NotFoundError('目标不存在');
        }
        throw new ConflictError('目标已在别处被修改，请刷新后重试');
      }
      return toGoal(row);
    },

    async findDetail(userId, goalId): Promise<GoalDetail | null> {
      const goal = await this.findById(userId, goalId);
      if (goal === null) {
        return null;
      }
      const actionRows = await db
        .select()
        .from(actions)
        .where(
          and(eq(actions.userId, userId), eq(actions.goalId, goalId), isNull(actions.deletedAt)),
        )
        .orderBy(asc(actions.createdAt), asc(actions.id));
      const actionList = actionRows.map(toAction);
      return {
        goal,
        actions: actionList,
        actionProgress: summarizeActionProgress(actionList),
      };
    },
  } satisfies GoalRepository;
}

export function createActionRepository(db: Database): ActionRepository {
  return {
    async findById(userId, actionId) {
      const rows = await db
        .select()
        .from(actions)
        .where(and(eq(actions.userId, userId), eq(actions.id, actionId), isNull(actions.deletedAt)))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toAction(row);
    },

    async listByGoal(userId, goalId) {
      const rows = await db
        .select()
        .from(actions)
        .where(
          and(eq(actions.userId, userId), eq(actions.goalId, goalId), isNull(actions.deletedAt)),
        )
        .orderBy(asc(actions.createdAt), asc(actions.id));
      return rows.map(toAction);
    },

    async create(userId, goalId, input) {
      const rows = await db
        .insert(actions)
        .values({
          userId,
          goalId,
          name: input.name,
          minimumVersion: input.minimumVersion,
          targetFrequency: input.targetFrequency,
          estimatedMinutes: input.estimatedMinutes,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error('行动创建后未能读回');
      }
      return toAction(row);
    },

    async update(userId, actionId, expectedVersion, patch) {
      const updates: Partial<ActionRow> = {};
      if (patch.status !== undefined) {
        updates.status = patch.status;
      }
      if (patch.targetFrequency !== undefined) {
        updates.targetFrequency = patch.targetFrequency;
      }
      if (patch.minimumVersion !== undefined) {
        updates.minimumVersion = patch.minimumVersion;
      }
      if (patch.estimatedMinutes !== undefined) {
        updates.estimatedMinutes = patch.estimatedMinutes;
      }

      const rows = await db
        .update(actions)
        .set({ ...updates, version: sql`${actions.version} + 1` })
        .where(
          and(
            eq(actions.userId, userId),
            eq(actions.id, actionId),
            isNull(actions.deletedAt),
            eq(actions.version, expectedVersion),
          ),
        )
        .returning();
      const row = rows[0];
      if (row === undefined) {
        const existing = await this.findById(userId, actionId);
        if (existing === null) {
          throw new NotFoundError('行动不存在');
        }
        throw new ConflictError('行动已在别处被修改，请刷新后重试');
      }
      return toAction(row);
    },

    async softDelete(userId, actionId) {
      // 软删行动与"解链任务"必须在同一事务：否则存在一个窗口，任务指向已删除的行动，
      // 详情无法解析。解链只清 `action_id`，`goal_id` 保留、任务不删（GOAL-002）。
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(actions)
          .set({ deletedAt: new Date(), version: sql`${actions.version} + 1` })
          .where(
            and(eq(actions.userId, userId), eq(actions.id, actionId), isNull(actions.deletedAt)),
          )
          .returning();
        if (rows.length === 0) {
          return false;
        }
        // @user-scope-exempt: actionId 是全局唯一主键，归属已由本事务上一条按 userId 的更新确认
        await tx.update(tasks).set({ actionId: null }).where(eq(tasks.actionId, actionId));
        return true;
      });
    },

    async listHabitActions(userId) {
      const rows = await db
        .select({ action: actions })
        .from(actions)
        .innerJoin(goals, eq(actions.goalId, goals.id))
        // 习惯＝active 目标下带 target_frequency 的行动（冻结口径，无独立表）。
        .where(
          and(
            eq(actions.userId, userId),
            isNull(actions.deletedAt),
            eq(goals.status, 'active'),
            isNotNull(actions.targetFrequency),
          ),
        )
        .orderBy(asc(actions.createdAt), asc(actions.id));
      return rows.map((row) => toAction(row.action));
    },
  } satisfies ActionRepository;
}
