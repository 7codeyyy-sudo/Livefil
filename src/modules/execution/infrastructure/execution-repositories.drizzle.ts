/**
 * 执行记录与恢复状态仓储 Drizzle 实现（DB §4.8/§4.17）。
 */
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import {
  executionLogs,
  recoveryStates,
  type ExecutionLogRow,
} from '@/infrastructure/database/schema.ts';
import { ConflictError, NotFoundError } from '@/shared/errors/app-error.ts';

import {
  EXECUTION_STATUSES,
  type ExecutionLog,
  type ExecutionLogCreateInput,
  type ExecutionStatus,
} from '../domain/execution-log.ts';
import type {
  ExecutionLogPage,
  ExecutionLogRepository,
  ListExecutionLogsOptions,
  RecoveryState,
  RecoveryStateRepository,
} from '../domain/execution-repository.ts';

const STATUSES: readonly string[] = EXECUTION_STATUSES;

function toLog(row: ExecutionLogRow): ExecutionLog {
  if (!STATUSES.includes(row.status)) {
    throw new Error(`execution_logs.status 的取值不在契约集合内：${row.status}`);
  }
  return {
    id: row.id,
    userId: row.userId,
    taskId: row.taskId,
    actionId: row.actionId,
    scheduleBlockId: row.scheduleBlockId,
    status: row.status as ExecutionStatus,
    plannedMinutes: row.plannedMinutes,
    actualMinutes: row.actualMinutes,
    reasonCode: row.reasonCode as ExecutionLog['reasonCode'],
    note: row.note,
    energyLevel: row.energyLevel as ExecutionLog['energyLevel'],
    moodScore: row.moodScore,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 游标：`(occurred_at, id)` 的 base64（对客户端不透明）。 */
function encodeCursor(row: ExecutionLogRow): string {
  return Buffer.from(JSON.stringify({ t: row.occurredAt.toISOString(), i: row.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { time: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: string;
      i?: string;
    };
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string') {
      return null;
    }
    return { time: new Date(parsed.t), id: parsed.i };
  } catch {
    return null;
  }
}

export function createExecutionLogRepository(db: Database) {
  return {
    async create(userId: string, input: ExecutionLogCreateInput): Promise<ExecutionLog> {
      const rows = await db
        .insert(executionLogs)
        .values({ userId, ...input })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new ConflictError('执行记录写入失败');
      }
      return toLog(row);
    },

    async findById(userId: string, logId: string): Promise<ExecutionLog | null> {
      const rows = await db
        .select()
        .from(executionLogs)
        .where(and(eq(executionLogs.userId, userId), eq(executionLogs.id, logId)))
        .limit(1);
      return rows[0] === undefined ? null : toLog(rows[0]);
    },

    async list(userId: string, options: ListExecutionLogsOptions): Promise<ExecutionLogPage> {
      const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
      const conditions = [
        eq(executionLogs.userId, userId),
        gte(executionLogs.occurredAt, options.fromUtc),
        lt(executionLogs.occurredAt, options.toUtc),
      ];
      if (options.taskId !== undefined) {
        conditions.push(eq(executionLogs.taskId, options.taskId));
      }
      if (options.actionId !== undefined) {
        conditions.push(eq(executionLogs.actionId, options.actionId));
      }
      if (options.status !== undefined) {
        conditions.push(eq(executionLogs.status, options.status));
      }
      if (cursor !== null) {
        // 行值元组比较（Phase 3 任务仓储同款）：`(occurred_at, id)` 整体小于
        // 游标——分列 AND 会在同瞬多行时随机跳过一半（2026-09-22 审查修正）。
        conditions.push(
          sql`(${executionLogs.occurredAt}, ${executionLogs.id}) < (${cursor.time}, ${cursor.id})`,
        );
      }

      const rows = await db
        .select()
        .from(executionLogs)
        // @user-scope-exempt: conditions 首项恒为 eq(executionLogs.userId, userId)
        .where(and(...conditions))
        .orderBy(desc(executionLogs.occurredAt), desc(executionLogs.id))
        .limit(options.limit + 1);

      const hasMore = rows.length > options.limit;
      const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
      const last = pageRows[pageRows.length - 1];
      return {
        items: pageRows.map(toLog),
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
        hasMore,
      };
    },

    async listInWindow(
      userId: string,
      fromUtc: Date,
      toUtc: Date,
    ): Promise<readonly ExecutionLog[]> {
      const rows = await db
        .select()
        .from(executionLogs)
        .where(
          and(
            eq(executionLogs.userId, userId),
            gte(executionLogs.occurredAt, fromUtc),
            lt(executionLogs.occurredAt, toUtc),
          ),
        )
        .orderBy(asc(executionLogs.occurredAt));
      return rows.map(toLog);
    },

    async listOverlapping(
      userId: string,
      windowStartUtc: Date,
      windowEndUtc: Date,
    ): Promise<readonly ExecutionLog[]> {
      return this.listInWindow(userId, windowStartUtc, windowEndUtc);
    },
  } satisfies ExecutionLogRepository;
}

export function createRecoveryStateRepository(db: Database) {
  return {
    async get(userId: string): Promise<RecoveryState | null> {
      const rows = await db
        .select()
        .from(recoveryStates)
        .where(eq(recoveryStates.userId, userId))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : { enabled: row.enabled, since: row.since.toISOString() };
    },

    async set(userId: string, enabled: boolean): Promise<RecoveryState> {
      const now = new Date();
      const rows = await db
        .insert(recoveryStates)
        .values({ userId, enabled, since: now })
        // 单行 upsert（DB §4.17：主键即并发口径）；重复设置同一状态也刷新 since。
        .onConflictDoUpdate({
          target: recoveryStates.userId,
          set: { enabled, since: now, updatedAt: now },
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError('恢复状态写入失败');
      }
      return { enabled: row.enabled, since: row.since.toISOString() };
    },
  } satisfies RecoveryStateRepository;
}
