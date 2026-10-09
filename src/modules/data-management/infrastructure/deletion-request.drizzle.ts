/**
 * 账户删除请求仓储（OPS-002，《接口文档》§13 删除面；迁移 0009）。
 *
 * 三态一行：活跃＝`cancelled_at IS NULL AND purged_at IS NULL AND purge_at > now`。
 * 全部查询带 userId 作用域（IAM-004）。到期清理不走本仓储——由
 * `scripts/purge-deletions.mjs` 按 `purge_at` 全局扫描（cron 面，跨用户）。
 */
import { and, eq, gt, isNull } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import { deletionRequests } from '@/infrastructure/database/schema.ts';

import type { DeletionRequestRepository } from '../domain/data-ports.ts';

interface Window {
  readonly requestedAt: Date;
  readonly purgeAt: Date;
}

export function createDeletionRequestRepository(db: Database): DeletionRequestRepository {
  return {
    async getActive(userId, now): Promise<Window | null> {
      const rows = await db
        .select({ requestedAt: deletionRequests.requestedAt, purgeAt: deletionRequests.purgeAt })
        .from(deletionRequests)
        .where(
          and(
            eq(deletionRequests.userId, userId),
            isNull(deletionRequests.cancelledAt),
            isNull(deletionRequests.purgedAt),
            gt(deletionRequests.purgeAt, now),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : { requestedAt: row.requestedAt, purgeAt: row.purgeAt };
    },

    async request(userId, requestedAt, purgeAt): Promise<Window> {
      const rows = await db
        .insert(deletionRequests)
        .values({ userId, requestedAt, purgeAt })
        .returning({
          requestedAt: deletionRequests.requestedAt,
          purgeAt: deletionRequests.purgeAt,
        });
      const row = rows[0];
      if (row === undefined) {
        throw new Error('删除请求写入未返回行');
      }
      return { requestedAt: row.requestedAt, purgeAt: row.purgeAt };
    },

    async cancel(userId, now): Promise<boolean> {
      const rows = await db
        .update(deletionRequests)
        .set({ cancelledAt: now })
        .where(
          and(
            eq(deletionRequests.userId, userId),
            isNull(deletionRequests.cancelledAt),
            isNull(deletionRequests.purgedAt),
          ),
        )
        .returning({ id: deletionRequests.id });
      return rows.length > 0;
    },
  };
}
