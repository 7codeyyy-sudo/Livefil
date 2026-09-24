/**
 * 同步冲突记录的 Drizzle 实现（SYNC-004，《数据库设计文档》§4.14）。
 *
 * ## 两个约束决定了两段式写入
 *
 * 1. 部分唯一索引 `sync_conflicts_pending_unique`（`WHERE status = 'pending'`）保证
 *    同一实体只有一条待处理冲突——所以"插入"可能被静默跳过，跳过时必须是**刷新**
 *    而不是报错（客户端重发同一条操作时，服务端版本可能又变了）。
 * 2. 已解决的行不参与唯一性，因此同一实体再次冲突时可以另起一行；`findById` 读到的
 *    历史行仍可追溯"上一次冲突是怎么解决的"。
 */
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import { syncConflicts, type SyncConflictRow } from '@/infrastructure/database/schema.ts';
import { InvariantError } from '@/shared/errors/app-error.ts';

import { isSyncEntityType } from '../domain/sync-change.ts';
import type {
  RecordConflictInput,
  SyncConflict,
  SyncConflictRepository,
} from '../domain/sync-conflict.ts';

/** 行 → 领域实体。越界取值（有人绕过应用写库）明确报错，不静默放行。 */
function toConflict(row: SyncConflictRow): SyncConflict {
  if (!isSyncEntityType(row.entityType)) {
    throw new InvariantError({
      message: `sync_conflicts.entityType 的取值不在契约集合内：${row.entityType}`,
    });
  }
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    localVersion: row.localVersion,
    serverVersion: row.serverVersion,
    localPayload:
      row.localPayloadJson === null ? null : (row.localPayloadJson as Record<string, unknown>),
    serverPayload: row.serverPayloadJson as Record<string, unknown>,
    status: row.status === 'resolved' ? 'resolved' : 'pending',
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

export function createSyncConflictRepository(db: Database): SyncConflictRepository {
  /** 待处理冲突的唯一身份：`(userId, entityType, entityId)`。 */
  async function findPending(
    userId: string,
    input: Pick<RecordConflictInput, 'entityType' | 'entityId'>,
  ): Promise<SyncConflictRow | null> {
    const rows = await db
      .select()
      .from(syncConflicts)
      // 作用域谓词 + 待处理状态：只能命中"当前用户、当前待处理"的那一行（IAM-004）。
      .where(
        and(
          eq(syncConflicts.userId, userId),
          eq(syncConflicts.entityType, input.entityType),
          eq(syncConflicts.entityId, input.entityId),
          eq(syncConflicts.status, 'pending'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  return {
    async record(userId: string, input: RecordConflictInput): Promise<SyncConflict> {
      const inserted = await db
        .insert(syncConflicts)
        .values({
          userId,
          entityType: input.entityType,
          entityId: input.entityId,
          localVersion: input.localVersion,
          serverVersion: input.serverVersion,
          localPayloadJson: input.localPayload,
          serverPayloadJson: input.serverPayload,
        })
        // 不带冲突目标：命中部分唯一索引时静默跳过，转入下面的刷新路径。
        .onConflictDoNothing()
        .returning();

      const created = inserted[0];
      if (created !== undefined) {
        return toConflict(created);
      }

      const pending = await findPending(userId, input);
      if (pending === null) {
        throw new InvariantError({ message: '同步冲突写入后未能读回待处理记录' });
      }

      // 刷新而不是新建：conflictId 必须稳定（用户界面上正在确认的冲突不能换号），
      // 内容则要用最新一次比对的结果——否则用户二选时看到的是过期的服务端版本。
      const refreshed = await db
        .update(syncConflicts)
        .set({
          localVersion: input.localVersion,
          serverVersion: input.serverVersion,
          localPayloadJson: input.localPayload,
          serverPayloadJson: input.serverPayload,
        })
        .where(
          and(
            eq(syncConflicts.userId, userId),
            eq(syncConflicts.id, pending.id),
            eq(syncConflicts.status, 'pending'),
          ),
        )
        .returning();

      const row = refreshed[0];
      return row === undefined ? toConflict(pending) : toConflict(row);
    },

    async findById(userId: string, conflictId: string): Promise<SyncConflict | null> {
      const rows = await db
        .select()
        .from(syncConflicts)
        .where(and(eq(syncConflicts.userId, userId), eq(syncConflicts.id, conflictId)))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toConflict(row);
    },

    async markResolved(userId: string, conflictId: string): Promise<SyncConflict | null> {
      const rows = await db
        .update(syncConflicts)
        .set({
          status: 'resolved',
          resolvedAt: new Date(),
          version: sql`${syncConflicts.version} + 1`,
        })
        // 只对仍是 `pending` 的行生效：并发解决时后到者拿到 `null`，由调用方回 409。
        .where(
          and(
            eq(syncConflicts.userId, userId),
            eq(syncConflicts.id, conflictId),
            eq(syncConflicts.status, 'pending'),
          ),
        )
        .returning();
      const row = rows[0];
      return row === undefined ? null : toConflict(row);
    },
  };
}
