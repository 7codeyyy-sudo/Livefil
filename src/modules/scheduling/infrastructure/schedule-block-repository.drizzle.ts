/**
 * 时间块仓储 Drizzle 实现（SCHED-001）。
 */
import { and, asc, eq, gte, lt } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import { scheduleBlocks, type ScheduleBlockRow } from '@/infrastructure/database/schema.ts';
import { ConflictError, NotFoundError } from '@/shared/errors/app-error.ts';

import type {
  ScheduleBlock,
  ScheduleBlockCreateInput,
  ScheduleBlockPatch,
} from '../domain/schedule-block.ts';
import type { ScheduleBlockRepository } from '../domain/schedule-block-repository.ts';

const STATUSES = ['planned', 'active', 'completed', 'adjusted', 'cancelled'] as const;
const SOURCES = ['manual', 'suggested', 'imported', 'routine'] as const;

function toBlock(row: ScheduleBlockRow): ScheduleBlock {
  return {
    id: row.id,
    userId: row.userId,
    taskId: row.taskId,
    actionId: row.actionId,
    routineId: row.routineId,
    routineStepId: row.routineStepId,
    startsAtUtc: row.startsAtUtc,
    endsAtUtc: row.endsAtUtc,
    timezone: row.timezone,
    source: SOURCES.includes(row.source as never)
      ? (row.source as ScheduleBlock['source'])
      : 'manual',
    status: STATUSES.includes(row.status as never)
      ? (row.status as ScheduleBlock['status'])
      : 'planned',
    conflictState:
      row.conflictState === 'warning' || row.conflictState === 'confirmed'
        ? row.conflictState
        : 'none',
    version: row.version,
  };
}

/** 与窗口 `[start, end)` 有重叠的块条件：`starts < windowEnd && windowStart < ends`。 */
function windowCondition(userId: string, windowStartUtc: Date, windowEndUtc: Date) {
  return and(
    eq(scheduleBlocks.userId, userId),
    lt(scheduleBlocks.startsAtUtc, windowEndUtc),
    gte(scheduleBlocks.endsAtUtc, windowStartUtc),
  );
}

export function createScheduleBlockRepository(db: Database) {
  return {
    async findById(userId: string, blockId: string): Promise<ScheduleBlock | null> {
      const rows = await db
        .select()
        .from(scheduleBlocks)
        .where(and(eq(scheduleBlocks.userId, userId), eq(scheduleBlocks.id, blockId)))
        .limit(1);
      return rows[0] === undefined ? null : toBlock(rows[0]);
    },

    async listOverlapping(
      userId: string,
      windowStartUtc: Date,
      windowEndUtc: Date,
    ): Promise<readonly ScheduleBlock[]> {
      const rows = await db
        .select()
        .from(scheduleBlocks)
        // 窗口条件已含归属；`ends >= windowStart`（gte）让"前一块贴着窗口开始"
        // 的块也进入冲突/当日判定（今日聚合按本地日切 UTC 窗口，正是这个语义）。
        .where(windowCondition(userId, windowStartUtc, windowEndUtc))
        .orderBy(asc(scheduleBlocks.startsAtUtc), asc(scheduleBlocks.id));
      return rows.map(toBlock);
    },

    async create(userId: string, input: ScheduleBlockCreateInput): Promise<ScheduleBlock> {
      const rows = await db
        .insert(scheduleBlocks)
        .values({ userId, ...input })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new ConflictError('时间块创建失败');
      }
      return toBlock(row);
    },

    async bulkCreate(
      userId: string,
      inputs: readonly ScheduleBlockCreateInput[],
    ): Promise<readonly ScheduleBlock[]> {
      if (inputs.length === 0) {
        return [];
      }
      const rows = await db
        .insert(scheduleBlocks)
        .values(inputs.map((input) => ({ userId, ...input })))
        .returning();
      return rows.map(toBlock);
    },

    async update(
      userId: string,
      blockId: string,
      expectedVersion: number,
      patch: ScheduleBlockPatch & {
        readonly status?: ScheduleBlock['status'];
        readonly conflictState?: ScheduleBlock['conflictState'];
      },
    ): Promise<ScheduleBlock> {
      const current = await this.findById(userId, blockId);
      if (current === null) {
        throw new NotFoundError('时间块不存在');
      }
      if (current.version !== expectedVersion) {
        throw new ConflictError('时间块已被其他修改更新，请刷新后重试');
      }
      const written = await db
        .update(scheduleBlocks)
        // @user-scope-exempt: 归属已由上方 findById 按 userId 校验
        .set({
          ...(patch.taskId === undefined ? {} : { taskId: patch.taskId }),
          ...(patch.actionId === undefined ? {} : { actionId: patch.actionId }),
          ...(patch.startsAtUtc === undefined ? {} : { startsAtUtc: patch.startsAtUtc }),
          ...(patch.endsAtUtc === undefined ? {} : { endsAtUtc: patch.endsAtUtc }),
          ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.conflictState === undefined ? {} : { conflictState: patch.conflictState }),
          version: expectedVersion + 1,
        })
        .where(eq(scheduleBlocks.id, blockId))
        .returning();
      const row = written[0];
      if (row === undefined) {
        throw new NotFoundError('时间块不存在');
      }
      return toBlock(row);
    },
  } satisfies ScheduleBlockRepository;
}

export type ScheduleBlockRepositoryDrizzle = ReturnType<typeof createScheduleBlockRepository>;
