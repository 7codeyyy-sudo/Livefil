/**
 * 写操作幂等识别存储的 Drizzle 实现（TASK-001，《数据库设计文档》§4.15）。
 *
 * 语义（接口文档 §1.1 / §4）：
 * - 首次请求**占行**（processing）再执行业务——占位靠 `(user_id, key)` 唯一约束，
 *   行锁对"尚不存在的行"无能为力；
 * - 同 key 重试：已完成 → **重放**首次快照（409 `IDEMPOTENCY_REPLAY`）；
 *   处理中 → 冲突（409 `CONFLICT`，调用方稍后重试）；
 * - 同 key 但请求体指纹不同 → 400（把同一个键用在了不同操作上，是客户端错误）。
 */
import { and, eq } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import { idempotencyKeys } from '@/infrastructure/database/schema.ts';
import { ValidationError } from '@/shared/errors/app-error.ts';
import { hasPostgresErrorCode } from '@/shared/errors/postgres-error.ts';

/** PostgreSQL 的唯一约束冲突。 */
const UNIQUE_VIOLATION = '23505';

/** 占位结果的三种形态——编排层据此决定"执行业务"还是"返回重放/冲突"。 */
export type IdempotencyClaim =
  | { readonly outcome: 'claimed' }
  | { readonly outcome: 'replay'; readonly snapshot: unknown }
  | { readonly outcome: 'in-progress' };

/**
 * 幂等存储的具体接口。
 *
 * 这里给的是**具体类型**（`ReturnType`）；`app/_lib/idempotency.ts` 里定义的
 * `IdempotencyStore` 端口与之结构兼容，由组合根做赋值检查——基础设施不必为了
 * 满足一个属于消费方的接口而反向 import（那是 Phase 2 教训里"端口位置"问题的
 * 横切变体：幂等没有领域模块，端口归消费方所有）。
 */
export function createIdempotencyStore(db: Database) {
  return {
    /**
     * 占位：插入 `(userId, key, requestHash)`。
     *
     * 唯一冲突后回读既有行做三种区分——注意**不做**"先查后插"的预检：
     * 并发窗口里两个请求都能查到"不存在"，唯一约束才是硬保证。
     */
    async claim(userId: string, key: string, requestHash: string): Promise<IdempotencyClaim> {
      try {
        await db.insert(idempotencyKeys).values({ userId, key, requestHash });
        return { outcome: 'claimed' };
      } catch (error) {
        if (!hasPostgresErrorCode(error, UNIQUE_VIOLATION)) {
          throw error;
        }
      }

      const rows = await db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)))
        .limit(1);
      const existing = rows[0];
      if (existing === undefined) {
        // 唯一冲突却读不到行：占位事务已回滚（例如并发完成后的清理）。视为可重试占位。
        return { outcome: 'in-progress' };
      }
      if (existing.requestHash !== requestHash) {
        throw new ValidationError('Idempotency-Key 已被用于另一个不同的请求');
      }
      if (existing.status === 'completed' && existing.responseSnapshot !== null) {
        return { outcome: 'replay', snapshot: existing.responseSnapshot };
      }
      return { outcome: 'in-progress' };
    },

    /** 业务执行成功后落快照（重放方原样拿到它）。 */
    async complete(userId: string, key: string, snapshot: unknown): Promise<void> {
      await db
        .update(idempotencyKeys)
        .set({ status: 'completed', responseSnapshot: snapshot })
        .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    },

    /**
     * 业务执行失败后释放占位（删除 processing 行）。
     *
     * 失败＝什么都没发生：客户端带着同一个 key 重试应该走正常执行路径，
     * 而不是被一行永远停在 processing 的占位挡成 409。删除而不是回写状态，
     * 是因为占位行的唯一价值就是"这个 key 正在被占用"——执行都没发生，它就该消失。
     */
    async release(userId: string, key: string): Promise<void> {
      await db
        .delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    },
  };
}

export type IdempotencyStore = ReturnType<typeof createIdempotencyStore>;
