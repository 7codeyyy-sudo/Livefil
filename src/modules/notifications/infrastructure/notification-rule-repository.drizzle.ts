/**
 * 提醒规则仓储的 Drizzle 实现（NOTIFY-001，接口文档 §16）。
 *
 * 三层职责与既有仓储相同：行↔实体映射、事务边界、数据库错误 → 领域错误。
 * 三条本文件特有的纪律：
 *
 * - **`level` 只由服务端派生**：写入时按 `targetType` 算好落库，回读时也统一经
 *   同一个派生映射校验（库里出现枚举外的值即 `InvariantError`，而不是放行）。
 * - **重复 `(targetType, targetId, remindAt)` 用事务内预检**：§4.12.1 冻结的索引清单
 *   里没有这条唯一索引，擅自加索引等于改契约；预检 + 同事务写入已足够收敛本批的
 *   单用户场景（并发首建撞车的窗口在硬删语义下无正确性风险）。
 * - **硬删**（`DELETE` 入口）：交付记录经 `ON DELETE SET NULL` 保留，因此删除只需
 *   一条语句，不需要事务。
 */
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import { notificationRules, type NotificationRuleRow } from '@/infrastructure/database/schema.ts';
import { ConflictError, InvariantError, NotFoundError } from '@/shared/errors/app-error.ts';

import {
  deriveNotificationLevel,
  isNotificationRepeatRule,
  isNotificationLevel,
  isNotificationTargetType,
  type NotificationRule,
  type NotificationRuleCreateInput,
  type NotificationRulePatch,
} from '../domain/notification-rule.ts';
import type {
  ListNotificationRulesOptions,
  NotificationRuleRepository,
} from '../domain/notification-rule-repository.ts';

/** 行 → 领域实体。枚举列若被绕过应用写库，明确报错而不是把脏值传给上层。 */
function toNotificationRule(row: NotificationRuleRow): NotificationRule {
  if (!isNotificationTargetType(row.targetType)) {
    throw new InvariantError({ message: 'notification_rules.target_type 不在契约集合内' });
  }
  if (!isNotificationRepeatRule(row.repeatRule)) {
    throw new InvariantError({ message: 'notification_rules.repeat_rule 不在契约集合内' });
  }
  if (!isNotificationLevel(row.level)) {
    throw new InvariantError({ message: 'notification_rules.level 不在契约集合内' });
  }
  return {
    id: row.id,
    userId: row.userId,
    targetType: row.targetType,
    targetId: row.targetId,
    remindAt: row.remindAt,
    repeatRule: row.repeatRule,
    allowQuietHours: row.allowQuietHours,
    enabled: row.enabled,
    level: row.level,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 游标编码：`(created_at, id)` 的 base64url——对客户端不透明，对实现可解码。 */
function encodeCursor(row: NotificationRuleRow): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { readonly createdAt: Date; readonly id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      c?: unknown;
      i?: unknown;
    };
    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string') {
      return null;
    }
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }
    return { createdAt, id: parsed.i };
  } catch {
    return null;
  }
}

/** `target_id` 的匹配谓词：`review` 类恒为 NULL，用 `IS NULL`（`= NULL` 永不成立）。 */
function matchTargetId(targetId: string | null): SQL {
  return targetId === null
    ? isNull(notificationRules.targetId)
    : eq(notificationRules.targetId, targetId);
}

export function createNotificationRuleRepository(db: Database): NotificationRuleRepository {
  return {
    async listByUser(
      userId: string,
      options: ListNotificationRulesOptions,
    ): Promise<{
      items: readonly NotificationRule[];
      nextCursor: string | null;
      hasMore: boolean;
    }> {
      const filters: SQL[] = [];
      if (options.targetType !== undefined) {
        filters.push(eq(notificationRules.targetType, options.targetType));
      }
      if (options.targetId !== undefined) {
        filters.push(eq(notificationRules.targetId, options.targetId));
      }

      const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
      if (cursor !== null) {
        // 行值比较：两列同升序，同毫秒多行不会互相跳过。
        filters.push(
          sql`(${notificationRules.createdAt}, ${notificationRules.id}) > (${cursor.createdAt}, ${cursor.id})`,
        );
      }

      const rows = await db
        .select()
        .from(notificationRules)
        .where(and(eq(notificationRules.userId, userId), ...filters))
        .orderBy(asc(notificationRules.createdAt), asc(notificationRules.id))
        .limit(options.limit + 1);

      const hasMore = rows.length > options.limit;
      const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
      const last = pageRows[pageRows.length - 1];
      return {
        items: pageRows.map(toNotificationRule),
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
        hasMore,
      };
    },

    async findById(userId: string, ruleId: string): Promise<NotificationRule | null> {
      const rows = await db
        .select()
        .from(notificationRules)
        // 作用域与 id 一起进 WHERE：少了 userId 就是"猜 id 就能读到别人规则"的入口。
        .where(and(eq(notificationRules.userId, userId), eq(notificationRules.id, ruleId)))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toNotificationRule(row);
    },

    async create(userId: string, input: NotificationRuleCreateInput): Promise<NotificationRule> {
      return db.transaction(async (tx) => {
        const duplicated = await tx
          .select({ id: notificationRules.id })
          .from(notificationRules)
          .where(
            and(
              eq(notificationRules.userId, userId),
              eq(notificationRules.targetType, input.targetType),
              matchTargetId(input.targetId),
              eq(notificationRules.remindAt, input.remindAt),
            ),
          )
          .limit(1);

        if (duplicated[0] !== undefined) {
          throw new ConflictError('同一对象的该提醒时刻已存在规则');
        }

        const inserted = await tx
          .insert(notificationRules)
          .values({
            userId,
            targetType: input.targetType,
            targetId: input.targetId,
            remindAt: input.remindAt,
            repeatRule: input.repeatRule,
            allowQuietHours: input.allowQuietHours,
            // 等级由服务端派生写入，客户端永不可写。
            level: deriveNotificationLevel(input.targetType),
          })
          .returning();

        const row = inserted[0];
        if (row === undefined) {
          throw new InvariantError({ message: '创建提醒规则后数据库未返回记录' });
        }
        return toNotificationRule(row);
      });
    },

    async update(
      userId: string,
      ruleId: string,
      patch: NotificationRulePatch,
    ): Promise<NotificationRule> {
      return db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(notificationRules)
          .where(and(eq(notificationRules.userId, userId), eq(notificationRules.id, ruleId)))
          .limit(1);

        const existing = current[0];
        if (existing === undefined) {
          throw new NotFoundError('提醒规则不存在');
        }

        // 改 `remind_at` 可能与他条撞车：对象类型/对象 id 不在可改字段内，用既有行取值。
        if (patch.remindAt !== undefined) {
          const duplicated = await tx
            .select({ id: notificationRules.id })
            .from(notificationRules)
            .where(
              and(
                eq(notificationRules.userId, userId),
                eq(notificationRules.targetType, existing.targetType),
                matchTargetId(existing.targetId),
                eq(notificationRules.remindAt, patch.remindAt),
                ne(notificationRules.id, ruleId),
              ),
            )
            .limit(1);

          if (duplicated[0] !== undefined) {
            throw new ConflictError('同一对象的该提醒时刻已存在规则');
          }
        }

        const updates: Partial<{
          remindAt: string;
          repeatRule: string;
          allowQuietHours: boolean;
          enabled: boolean;
        }> = {};
        if (patch.remindAt !== undefined) {
          updates.remindAt = patch.remindAt;
        }
        if (patch.repeatRule !== undefined) {
          updates.repeatRule = patch.repeatRule;
        }
        if (patch.allowQuietHours !== undefined) {
          updates.allowQuietHours = patch.allowQuietHours;
        }
        if (patch.enabled !== undefined) {
          updates.enabled = patch.enabled;
        }

        const updated = await tx
          .update(notificationRules)
          .set(updates)
          .where(and(eq(notificationRules.userId, userId), eq(notificationRules.id, ruleId)))
          .returning();

        const row = updated[0];
        if (row === undefined) {
          throw new NotFoundError('提醒规则不存在');
        }
        return toNotificationRule(row);
      });
    },

    async delete(userId: string, ruleId: string): Promise<boolean> {
      const deleted = await db
        .delete(notificationRules)
        .where(and(eq(notificationRules.userId, userId), eq(notificationRules.id, ruleId)))
        .returning({ id: notificationRules.id });
      return deleted.length > 0;
    },
  };
}
