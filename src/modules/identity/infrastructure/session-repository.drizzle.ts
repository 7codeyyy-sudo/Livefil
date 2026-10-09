/**
 * 会话仓储的 Drizzle 实现（AUTH-002，《数据库设计文档》§4.19；RD-012 §2.2）。
 *
 * 所有查询以 `(sessionId, userId)` 或 `userId` 为谓词——会话的归属校验是
 * 跨用户隔离的第一道（IAM-004），令牌里的 uid 与行不符时查询层直接空手而归。
 *
 * 本表**不设 `updated_at`**（schema 即此设计）：`last_seen_at`/`revoked_at`
 * 各自有语义明确的时间列，再叠一个笼统的「最后修改时间」只会制造两个
 * 可能互相矛盾的真相（对齐 §4.12.1 不留死列的取舍）。
 */
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import { sessions, type SessionRow } from '@/infrastructure/database/schema.ts';
import {
  SESSION_TTL_DAYS,
  shouldRenew,
  type AuthSession,
  type CreateSessionInput,
  type SessionRepository,
} from '../domain/session.ts';

/** 行 → 领域实体。 */
function toSession(row: SessionRow): AuthSession {
  return {
    id: row.id,
    userId: row.userId,
    deviceLabel: row.deviceLabel,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * 创建会话仓储。
 *
 * @param db 绑定好 schema 的 Drizzle 句柄。时间由调用方以参数传入——
 * 用例层持有时钟（测试注入固定时钟），仓储只做存取。
 */
export function createSessionRepository(db: Database): SessionRepository {
  return {
    async create(input: CreateSessionInput): Promise<AuthSession> {
      const inserted = await db
        .insert(sessions)
        .values({
          userId: input.userId,
          deviceLabel: input.deviceLabel,
          expiresAt: input.expiresAt,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new Error('创建会话后数据库未返回记录');
      }
      return toSession(row);
    },

    findByIdForUser(sessionId: string, userId: string): Promise<AuthSession | null> {
      return db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
        .limit(1)
        .then((rows) => {
          const row = rows[0];
          return row === undefined ? null : toSession(row);
        });
    },

    async renewIfDue(
      sessionId: string,
      userId: string,
      nowDate: Date,
    ): Promise<AuthSession | null> {
      // 先读行判定（半衰点判据在域侧 shouldRenew，避免 SQL 与域规则两处漂移），
      // 写回时带 userId 谓词——即使读写之间行被改归属，更新也只会命中本用户。
      const rows = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
        .limit(1);

      const row = rows[0];
      if (row === undefined || row.revokedAt !== null) {
        return null;
      }

      if (!shouldRenew(row.expiresAt, nowDate)) {
        // 未到半衰点：不产生写（滑动续期只在剩余 <15 天时触发，RD-012 §3 流 4）。
        return null;
      }

      const updated = await db
        .update(sessions)
        .set({
          expiresAt: new Date(nowDate.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
          lastSeenAt: nowDate,
        })
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
        .returning();

      const renewed = updated[0];
      return renewed === undefined ? null : toSession(renewed);
    },

    async touch(sessionId: string, userId: string, nowDate: Date): Promise<void> {
      // 节流 ≥5 分钟：DB 侧用 WHERE 一并判定，避免「读节流—写」竞态与每请求写放大。
      await db
        .update(sessions)
        .set({ lastSeenAt: nowDate })
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.userId, userId),
            lt(sessions.lastSeenAt, new Date(nowDate.getTime() - 5 * 60 * 1000)),
          ),
        );
    },

    async revoke(sessionId: string, userId: string, nowDate: Date): Promise<void> {
      await db
        .update(sessions)
        .set({ revokedAt: nowDate })
        .where(
          and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)),
        );
    },

    async revokeAll(userId: string, nowDate: Date): Promise<void> {
      await db
        .update(sessions)
        .set({ revokedAt: nowDate })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    },

    async revokeOthers(userId: string, keepSessionId: string | null, nowDate: Date): Promise<void> {
      // 谓词内联而不是抽成变量：用户作用域的静态判定（IAM-004）按文本扫描
      // where 子句的实参——抽走 userId 后扫描器看不见作用域，守恒断言即破。
      await db
        .update(sessions)
        .set({ revokedAt: nowDate })
        .where(
          keepSessionId === null
            ? and(eq(sessions.userId, userId), isNull(sessions.revokedAt))
            : and(
                eq(sessions.userId, userId),
                isNull(sessions.revokedAt),
                ne(sessions.id, keepSessionId),
              ),
        );
    },

    async purgeExpired(userId: string, nowDate: Date): Promise<void> {
      // 惰性清理：登录时删本人已过期/已吊销行——不引入 cron（RD-012 §2.2）。
      await db
        .delete(sessions)
        .where(
          and(
            eq(sessions.userId, userId),
            or(lt(sessions.expiresAt, nowDate), sql`${sessions.revokedAt} IS NOT NULL`),
          ),
        );
    },
  };
}
