/**
 * 同步增量拉取的 Drizzle 实现（SYNC-001，《接口文档》§12.1.2）。
 *
 * ## 为什么是"每表取 limit+1 再合并"，而不是一条 UNION
 *
 * 9 张表的列集合互不相同，UNION 只能把行压成同一组列——要么手写一长串
 * `select ... as ...` 投影（每张表一处，与注册表形成第二份真相），要么退化成
 * `to_jsonb(t.*)`（键变 snake_case，与接口文档的 camelCase 口径对不上）。
 * 每表各取一页再按 `(changeAt, id)` 归并，代价是**多取**（最多 9×101 行），
 * 换来的是：排序键与游标格式只有一份实现、payload 与 GET 端点的字段名同源。
 * 本地模式的单用户数据量下，这个代价可以忽略。
 *
 * ## 归并的正确性
 *
 * 取"全局最小的 N 条"只需要每张表各取最小的 N 条：全局第 N 小的行，在它所属的那张
 * 表里也必然排在前 N。因此每表多取 1 条（`limit + 1`）不仅能选出前 `limit` 条，
 * 还能判断"是否还有更多"——只有全部表都不足时才真的取尽。
 */
import { and, asc, eq, lte, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';

import { encodePullCursor, type PullCursor, type SyncChange } from '../domain/sync-change.ts';
import type {
  ListChangesOptions,
  SyncChangePage,
  SyncRepository,
} from '../domain/sync-repository.ts';
import {
  asPlainRow,
  readChangeAt,
  readVersion,
  serializeRow,
  SYNC_ENTITY_SPECS,
  type SyncEntitySpec,
} from './sync-entities.ts';

/** 行 → 一条变更。 */
function toChange(spec: SyncEntitySpec, row: ReturnType<typeof asPlainRow>): SyncChange {
  return {
    entityType: spec.entityType,
    entityId: String(row['id']),
    version: readVersion(spec, row),
    deleted: spec.deletedOf(row),
    payload: serializeRow(row),
    changeAt: readChangeAt(spec, row),
  };
}

/**
 * 变更排序：先按变更时刻，再按 id。
 *
 * 与游标的复合键**必须是同一个顺序**：游标比较用的是行值比较 `(changeAt, id) > 游标`，
 * 若这里只按时刻排序，同一时刻的多行顺序就与游标推进的顺序不一致，会被跳过。
 */
function compareChanges(a: SyncChange, b: SyncChange): number {
  const byTime = a.changeAt.getTime() - b.changeAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  if (a.entityId === b.entityId) {
    return 0;
  }
  return a.entityId < b.entityId ? -1 : 1;
}

export function createSyncRepository(db: Database): SyncRepository {
  return {
    async listChanges(userId: string, options: ListChangesOptions): Promise<SyncChangePage> {
      const after: PullCursor | null = options.after;
      const effectiveLimit = Math.min(options.limit, 100);
      const collected: SyncChange[] = [];

      for (const spec of SYNC_ENTITY_SPECS) {
        const conditions = [lte(spec.changeAt, options.until)];
        if (after !== null) {
          // 行值比较：`(changeAt, id)` 整体大于游标。写成两条 OR 会让索引退化成位图扫描。
          conditions.push(
            sql`(${spec.changeAt}, ${spec.idColumn}) > (${new Date(after.changeAtMs)}, ${after.id})`,
          );
        }

        const rows = await db
          .select()
          .from(spec.table)
          // 作用域谓词与其余条件同处一个 and：`userId` 必须出现在每一个查询分支里（IAM-004）。
          .where(and(eq(spec.userIdColumn, userId), ...conditions))
          .orderBy(asc(spec.changeAt), asc(spec.idColumn))
          .limit(effectiveLimit + 1);

        for (const row of rows) {
          collected.push(toChange(spec, asPlainRow(row)));
        }
      }

      collected.sort(compareChanges);
      const changes = collected.slice(0, effectiveLimit);
      const last = changes[changes.length - 1];

      return {
        changes,
        nextCursor:
          last === undefined
            ? null
            : encodePullCursor({ changeAtMs: last.changeAt.getTime(), id: last.entityId }),
        hasMore: collected.length > effectiveLimit,
      };
    },
  };
}
