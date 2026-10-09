/**
 * 验证码仓储的 Drizzle 实现（AUTH-002，《数据库设计文档》§4.20；RD-012 §2.4）。
 *
 * ## 全部查询按 email 定位——用户作用域豁免的理由
 *
 * 注册时用户**尚不存在**，登录/重置时会话尚未建立：按 `(email, purpose)`
 * 定位正是这些流程的语义本身（同 `findLocalUser` 的豁免性质）。每处查询带
 * 显式 `@user-scope-exempt` 标记，理由可核（IAM-004 静态判定纪律）。
 *
 * ## consume 为什么必须在事务里做
 *
 * 「读活跃码 → 比对 → 消费」三步若分离，并发的两个核码请求会同时读到
 * 未消费的码、同时通过比对——一次性码被花两次。`SELECT ... FOR UPDATE`
 * 把判定与消费压进同一把行锁，双花在库层就不可能。
 */
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import {
  emailVerificationCodes,
  type EmailVerificationCodeRow,
} from '@/infrastructure/database/schema.ts';
import type {
  CodeFailureReason,
  IssueCodeInput,
  VerificationCode,
  VerificationCodeRepository,
  VerificationPurpose,
} from '../domain/verification-code.ts';
import { CODE_MAX_ATTEMPTS } from '../domain/verification-code.ts';
import { timingSafeHexEqual } from './verification-code-crypto.ts';

/** 行 → 领域实体。 */
function toCode(row: EmailVerificationCodeRow): VerificationCode {
  return {
    id: row.id,
    email: row.email,
    purpose: row.purpose as VerificationPurpose,
    attempts: row.attempts,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  };
}

export function createVerificationCodeRepository(db: Database): VerificationCodeRepository {
  return {
    async issue(input: IssueCodeInput): Promise<void> {
      await db.transaction(async (tx) => {
        // 单活跃码：同事务置同 (email,purpose) 旧码 consumed（RD-012 §2.4）。
        // @user-scope-exempt: 注册前用户尚不存在，验证码按邮箱与用途定位
        await tx
          .update(emailVerificationCodes)
          .set({ consumedAt: new Date() })
          .where(
            and(
              eq(emailVerificationCodes.email, input.email),
              eq(emailVerificationCodes.purpose, input.purpose),
              isNull(emailVerificationCodes.consumedAt),
            ),
          );

        await tx.insert(emailVerificationCodes).values({
          email: input.email,
          purpose: input.purpose,
          codeHash: input.codeHash,
          expiresAt: input.expiresAt,
        });
      });
    },

    // 认证前按邮箱定位（同 issue 的豁免性质）。
    // @user-scope-exempt: 注册与登录前用户尚不存在，验证码按邮箱与用途定位
    findActive(
      email: string,
      purpose: VerificationPurpose,
      now: Date,
    ): Promise<VerificationCode | null> {
      return db
        .select()
        .from(emailVerificationCodes)
        .where(
          and(
            eq(emailVerificationCodes.email, email),
            eq(emailVerificationCodes.purpose, purpose),
            isNull(emailVerificationCodes.consumedAt),
            // 未过期：expires_at > now。
            sql`${emailVerificationCodes.expiresAt} > ${now}`,
          ),
        )
        .orderBy(emailVerificationCodes.createdAt)
        .limit(1)
        .then((rows) => {
          const row = rows[0];
          return row === undefined ? null : toCode(row);
        });
    },

    async consume(
      email: string,
      purpose: VerificationPurpose,
      codeHash: string,
      now: Date,
    ): Promise<CodeFailureReason | null> {
      return db.transaction(async (tx) => {
        // 行锁把「判定 + 消费」压进同一临界区（见文件头注释）。
        // @user-scope-exempt: 认证前按邮箱定位验证码，注册时用户尚不存在
        const rows = await tx
          .select()
          .from(emailVerificationCodes)
          .where(
            and(
              eq(emailVerificationCodes.email, email),
              eq(emailVerificationCodes.purpose, purpose),
              isNull(emailVerificationCodes.consumedAt),
            ),
          )
          .orderBy(emailVerificationCodes.createdAt)
          .limit(1)
          .for('update');

        const row = rows[0];
        if (row === undefined) {
          // 没有活跃码：要么从未发出，要么已消费（一次性）。
          return 'consumed';
        }

        if (row.expiresAt.getTime() <= now.getTime()) {
          return 'expired';
        }

        if (row.attempts >= CODE_MAX_ATTEMPTS) {
          // 已达上限的码仍被查出（attempts 累计不重置）——按作废处理并固化。
          // @user-scope-exempt: 码行 id 来自上方带邮箱定位的行锁查询，注册前无 userId
          await tx
            .update(emailVerificationCodes)
            .set({ consumedAt: now })
            .where(eq(emailVerificationCodes.id, row.id));
          return 'attempts_exhausted';
        }

        if (!timingSafeHexEqual(codeHash, row.codeHash)) {
          const nextAttempts = row.attempts + 1;
          // @user-scope-exempt: 码行 id 来自上方带邮箱定位的行锁查询，注册前无 userId
          await tx
            .update(emailVerificationCodes)
            .set({
              attempts: nextAttempts,
              // ≥5 次即作废（错验计数与上限同点落地，不用等下次查询才失效）。
              ...(nextAttempts >= CODE_MAX_ATTEMPTS ? { consumedAt: now } : {}),
            })
            .where(eq(emailVerificationCodes.id, row.id));
          return nextAttempts >= CODE_MAX_ATTEMPTS ? 'attempts_exhausted' : 'invalid';
        }

        // @user-scope-exempt: 码行 id 来自上方带邮箱定位的行锁查询，注册前无 userId
        await tx
          .update(emailVerificationCodes)
          .set({ consumedAt: now })
          .where(eq(emailVerificationCodes.id, row.id));
        return null;
      });
    },

    // 频控计数同样是认证前的邮箱维度查询（豁免性质同上）。
    // 计数跨 purpose 合并——按 purpose 分桶会让用途轮换绕过限流。
    // @user-scope-exempt: 发码频控按邮箱计数，认证前无 userId 可用
    countSince(email: string, since: Date): Promise<number> {
      return db
        .select({ count: sql<number>`count(*)::int` })
        .from(emailVerificationCodes)
        .where(
          and(
            eq(emailVerificationCodes.email, email),
            // (email, purpose, created_at) 索引的前缀 (email) 支持本窗口扫描；
            // 5–20 用户规模下跨 purpose 的行数扫描成本可忽略。
            sql`${emailVerificationCodes.createdAt} >= ${since}`,
          ),
        )
        .then((rows) => rows[0]?.count ?? 0);
    },
  };
}
