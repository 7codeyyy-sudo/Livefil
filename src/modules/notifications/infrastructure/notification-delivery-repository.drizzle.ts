/**
 * 提醒交付仓储的 Drizzle 实现（NOTIFY-002，接口文档 §16、数据库设计 §4.12.2）。
 *
 * ## 读时物化（本文件的核心）
 *
 * 冻结契约没有"创建 delivery"的端点或定时任务，但 `GET /notifications/pending`
 * 必须返回 `status ∈ {pending, failed}` 的行。落法是**读时物化**：读取时扫描本用户
 * 的启用规则、算出本次应触发时刻、补落 `pending` 行。
 *
 * 物化与「三类 `cancelled` 重分类」在**同一次读路径事务**内、**先作废后物化**——
 * 反过来会让"刚被关掉的规则"在同一次调用里又落一条新 `pending`。
 *
 * ## 三类作废只作用于 `pending`
 *
 * `sent` / `failed` 是已触达的事实，不可改写；`cancelled` 是"未触达即作废"。
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import {
  notificationDeliveries,
  notificationRules,
  routines,
  tasks,
  users,
  type NotificationDeliveryRow,
} from '@/infrastructure/database/schema.ts';
import { ConflictError, InvariantError, NotFoundError } from '@/shared/errors/app-error.ts';

import {
  NOTIFICATION_LEVEL_RANK,
  NOTIFICATION_LEVELS,
  isNotificationLevel,
  isNotificationRepeatRule,
  isNotificationTargetType,
} from '../domain/notification-rule.ts';
import {
  MAX_NOTIFICATION_ATTEMPTS,
  computeNextRetryAt,
  isNotificationChannel,
  isNotificationDeliveryStatus,
  isNotificationErrorCode,
  type NotificationDelivery,
  type NotificationDeliveryPage,
  type ReportNotificationAttemptInput,
} from '../domain/notification-delivery.ts';
import type {
  ListNotificationDeliveriesOptions,
  NotificationDeliveryRepository,
} from '../domain/notification-delivery-repository.ts';
import { resolveReminderOccurrence } from '../domain/reminder-schedule.ts';

/**
 * 面板排序的等级权重表达式：关键 > 普通 > 复盘。
 *
 * 权重值取自 `NOTIFICATION_LEVEL_RANK`（领域唯一来源），不在这里重写一遍——
 * 否则"调整枚举权重"会悄悄与 SQL 里的字面量产生漂移。
 */
const LEVEL_RANK_ORDER = sql`CASE ${notificationDeliveries.level} ${sql.join(
  NOTIFICATION_LEVELS.map((level) => sql`WHEN ${level} THEN ${NOTIFICATION_LEVEL_RANK[level]}`),
  sql` `,
)} ELSE ${sql.raw(String(NOTIFICATION_LEVELS.length))} END`;

/** 行 → 领域实体。枚举列若被绕过应用写库，明确报错而不是把脏值传给上层。 */
function toNotificationDelivery(row: NotificationDeliveryRow): NotificationDelivery {
  if (!isNotificationTargetType(row.targetType)) {
    throw new InvariantError({ message: 'notification_deliveries.target_type 不在契约集合内' });
  }
  if (!isNotificationChannel(row.channel)) {
    throw new InvariantError({ message: 'notification_deliveries.channel 不在契约集合内' });
  }
  if (!isNotificationLevel(row.level)) {
    throw new InvariantError({ message: 'notification_deliveries.level 不在契约集合内' });
  }
  if (!isNotificationDeliveryStatus(row.status)) {
    throw new InvariantError({ message: 'notification_deliveries.status 不在契约集合内' });
  }
  if (row.errorCode !== null && !isNotificationErrorCode(row.errorCode)) {
    throw new InvariantError({ message: 'notification_deliveries.error_code 不在契约集合内' });
  }
  return {
    id: row.id,
    userId: row.userId,
    ruleId: row.ruleId,
    targetType: row.targetType,
    targetId: row.targetId,
    channel: row.channel,
    level: row.level,
    status: row.status,
    scheduledFor: row.scheduledFor.toISOString(),
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    errorCode: row.errorCode,
    nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 游标编码：`(scheduled_for, id)` 的 base64url。 */
function encodeCursor(row: NotificationDeliveryRow): string {
  return Buffer.from(JSON.stringify({ s: row.scheduledFor.toISOString(), i: row.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { readonly scheduledFor: Date; readonly id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      s?: unknown;
      i?: unknown;
    };
    if (typeof parsed.s !== 'string' || typeof parsed.i !== 'string') {
      return null;
    }
    const scheduledFor = new Date(parsed.s);
    if (Number.isNaN(scheduledFor.getTime())) {
      return null;
    }
    return { scheduledFor, id: parsed.i };
  } catch {
    return null;
  }
}

export function createNotificationDeliveryRepository(db: Database): NotificationDeliveryRepository {
  /**
   * 三类「未触达即作废」重分类（同事务内、物化之前）。
   *
   * 只作用于 `status = 'pending'`：已触达（`sent`）与已失败（`failed`）是事实。
   */
  async function cancelStale(
    tx: Database,
    userId: string,
    reminderEnabled: boolean,
  ): Promise<void> {
    const onlyPending = eq(notificationDeliveries.status, 'pending');

    // ② 全局关闭：该用户所有待触达一次性作废。
    if (!reminderEnabled) {
      await tx
        .update(notificationDeliveries)
        .set({ status: 'cancelled' })
        .where(and(eq(notificationDeliveries.userId, userId), onlyPending));
      return;
    }

    // ① 规则不再处于启用态（被关闭，或规则被硬删后 `rule_id` 置 NULL）：待触达作废。
    await tx
      .update(notificationDeliveries)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(notificationDeliveries.userId, userId),
          onlyPending,
          sql`NOT EXISTS (SELECT 1 FROM ${notificationRules} WHERE ${notificationRules.id} = ${notificationDeliveries.ruleId} AND ${notificationRules.userId} = ${notificationDeliveries.userId} AND ${notificationRules.enabled} = true)`,
        ),
      );

    // ③ 目标已完成或已删（任务完成/软删、例程软删）：`review` 类不绑定实体，不适用。
    await tx
      .update(notificationDeliveries)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(notificationDeliveries.userId, userId),
          onlyPending,
          or(
            and(
              eq(notificationDeliveries.targetType, 'task'),
              sql`NOT EXISTS (SELECT 1 FROM ${tasks} WHERE ${tasks.id} = ${notificationDeliveries.targetId} AND ${tasks.userId} = ${notificationDeliveries.userId} AND ${tasks.status} <> 'completed' AND ${tasks.deletedAt} IS NULL)`,
            ),
            and(
              eq(notificationDeliveries.targetType, 'routine'),
              sql`NOT EXISTS (SELECT 1 FROM ${routines} WHERE ${routines.id} = ${notificationDeliveries.targetId} AND ${routines.userId} = ${notificationDeliveries.userId} AND ${routines.deletedAt} IS NULL)`,
            ),
          ),
        ),
      );
  }

  /** 扫描启用规则，补落本次应触发的 `pending` 行（存在性判重，不加唯一索引）。 */
  async function materialize(
    tx: Database,
    userId: string,
    now: Date,
    context: {
      readonly timeZone: string;
      readonly quietHoursStart: string | null;
      readonly quietHoursEnd: string | null;
    },
  ): Promise<void> {
    const rules = await tx
      .select()
      .from(notificationRules)
      .where(and(eq(notificationRules.userId, userId), eq(notificationRules.enabled, true)));

    for (const rule of rules) {
      if (
        !isNotificationTargetType(rule.targetType) ||
        !isNotificationLevel(rule.level) ||
        !isNotificationRepeatRule(rule.repeatRule)
      ) {
        throw new InvariantError({ message: 'notification_rules 行含契约外的枚举值' });
      }

      const occurrence = resolveReminderOccurrence(
        {
          remindAt: rule.remindAt,
          repeatRule: rule.repeatRule,
          allowQuietHours: rule.allowQuietHours,
          createdAt: rule.createdAt.toISOString(),
        },
        {
          timeZone: context.timeZone,
          now,
          quietHoursStart: context.quietHoursStart,
          quietHoursEnd: context.quietHoursEnd,
        },
      );

      if (occurrence === null) {
        continue;
      }

      // 幂等：按 `(user_id, rule_id, scheduled_for)` 读路径存在性判重（契约未设唯一索引）。
      const existing = await tx
        .select({ id: notificationDeliveries.id })
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.userId, userId),
            eq(notificationDeliveries.ruleId, rule.id),
            eq(notificationDeliveries.scheduledFor, occurrence),
          ),
        )
        .limit(1);

      if (existing[0] !== undefined) {
        continue;
      }

      await tx.insert(notificationDeliveries).values({
        userId,
        ruleId: rule.id,
        targetType: rule.targetType,
        targetId: rule.targetId,
        channel: 'in_app',
        level: rule.level,
        status: 'pending',
        scheduledFor: occurrence,
        attemptCount: 0,
      });
    }
  }

  return {
    async materializePending(userId: string, now: Date): Promise<void> {
      await db.transaction(async (tx) => {
        const userRows = await tx
          .select({
            reminderEnabled: users.reminderEnabled,
            timezone: users.timezone,
            quietHoursStart: users.quietHoursStart,
            quietHoursEnd: users.quietHoursEnd,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        const user = userRows[0];
        if (user === undefined) {
          throw new NotFoundError('用户不存在');
        }

        // 先作废后物化（顺序不可交换，否则关掉的规则会在同一次调用里又落一条）。
        await cancelStale(tx, userId, user.reminderEnabled);

        if (!user.reminderEnabled) {
          return;
        }

        await materialize(tx, userId, now, {
          timeZone: user.timezone,
          quietHoursStart: user.quietHoursStart,
          quietHoursEnd: user.quietHoursEnd,
        });
      });
    },

    async listPending(userId: string): Promise<readonly NotificationDelivery[]> {
      const rows = await db
        .select()
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.userId, userId),
            // `failed` 也在列表内：FR-071「通知失败时应用内仍应显示待处理提醒」。
            inArray(notificationDeliveries.status, ['pending', 'failed']),
            isNull(notificationDeliveries.dismissedAt),
          ),
        )
        .orderBy(LEVEL_RANK_ORDER, asc(notificationDeliveries.scheduledFor));
      return rows.map(toNotificationDelivery);
    },

    async listByUser(
      userId: string,
      options: ListNotificationDeliveriesOptions,
    ): Promise<NotificationDeliveryPage> {
      const filters: SQL[] = [];
      if (options.status !== undefined) {
        filters.push(eq(notificationDeliveries.status, options.status));
      }
      if (options.onlyRetryable === true) {
        // "可重试"＝失败 + 未达上限 + `next_retry_at` 非空（确定性失败与达上限者都不在内）。
        filters.push(eq(notificationDeliveries.status, 'failed'));
        filters.push(sql`${notificationDeliveries.nextRetryAt} IS NOT NULL`);
        filters.push(sql`${notificationDeliveries.attemptCount} < ${MAX_NOTIFICATION_ATTEMPTS}`);
      }

      const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
      if (cursor !== null) {
        filters.push(
          sql`(${notificationDeliveries.scheduledFor}, ${notificationDeliveries.id}) < (${cursor.scheduledFor}, ${cursor.id})`,
        );
      }

      const rows = await db
        .select()
        .from(notificationDeliveries)
        .where(and(eq(notificationDeliveries.userId, userId), ...filters))
        .orderBy(desc(notificationDeliveries.scheduledFor), desc(notificationDeliveries.id))
        .limit(options.limit + 1);

      const hasMore = rows.length > options.limit;
      const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
      const last = pageRows[pageRows.length - 1];
      return {
        items: pageRows.map(toNotificationDelivery),
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
        hasMore,
      };
    },

    async findById(userId: string, deliveryId: string): Promise<NotificationDelivery | null> {
      const rows = await db
        .select()
        .from(notificationDeliveries)
        .where(
          and(eq(notificationDeliveries.userId, userId), eq(notificationDeliveries.id, deliveryId)),
        )
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toNotificationDelivery(row);
    },

    async dismiss(userId: string, deliveryId: string, now: Date): Promise<NotificationDelivery> {
      const rows = await db
        .select()
        .from(notificationDeliveries)
        .where(
          and(eq(notificationDeliveries.userId, userId), eq(notificationDeliveries.id, deliveryId)),
        )
        .limit(1);

      const existing = rows[0];
      if (existing === undefined) {
        throw new NotFoundError('提醒交付记录不存在');
      }
      // 幂等：已处理过就直接返回当前行，不重复写（`dismissed_at` 保持首次时刻）。
      if (existing.dismissedAt !== null) {
        return toNotificationDelivery(existing);
      }

      const updated = await db
        .update(notificationDeliveries)
        .set({ dismissedAt: now })
        .where(
          and(eq(notificationDeliveries.userId, userId), eq(notificationDeliveries.id, deliveryId)),
        )
        .returning();

      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError('提醒交付记录不存在');
      }
      return toNotificationDelivery(row);
    },

    async reportAttempt(
      userId: string,
      deliveryId: string,
      input: ReportNotificationAttemptInput,
      now: Date,
      random: () => number = Math.random,
    ): Promise<NotificationDelivery> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(notificationDeliveries)
          .where(
            and(
              eq(notificationDeliveries.userId, userId),
              eq(notificationDeliveries.id, deliveryId),
            ),
          )
          .limit(1)
          .for('update');

        const existing = rows[0];
        if (existing === undefined) {
          throw new NotFoundError('提醒交付记录不存在');
        }
        if (existing.status === 'sent' || existing.status === 'cancelled') {
          throw new ConflictError('该提醒已处于终态，不能再上报触达结果');
        }
        if (existing.status === 'failed' && existing.attemptCount >= MAX_NOTIFICATION_ATTEMPTS) {
          throw new ConflictError('该提醒已达重试上限，不再接受触达上报');
        }

        const attemptCount = existing.attemptCount + 1;
        const sent = input.outcome === 'sent';

        const failedFields: {
          readonly status: 'failed';
          readonly errorCode: NonNullable<ReportNotificationAttemptInput['errorCode']>;
          readonly nextRetryAt: Date | null;
        } = (() => {
          const errorCode = input.errorCode;
          if (errorCode === null) {
            // 用例层已保证 `failed` 必有 errorCode；走到这里说明调用方绕过了校验。
            throw new InvariantError({ message: '触达失败上报缺少 error_code' });
          }
          return {
            status: 'failed',
            errorCode,
            nextRetryAt: computeNextRetryAt(attemptCount, errorCode, now, random),
          };
        })();

        const updated = await tx
          .update(notificationDeliveries)
          .set(
            sent
              ? {
                  status: 'sent',
                  errorCode: null,
                  attemptCount,
                  lastAttemptAt: now,
                  nextRetryAt: null,
                  // 第 6 条派生规则：无论成败，落痕即把渠道翻为 `browser`。
                  channel: 'browser',
                }
              : {
                  ...failedFields,
                  attemptCount,
                  lastAttemptAt: now,
                  channel: 'browser',
                },
          )
          .where(
            and(
              eq(notificationDeliveries.userId, userId),
              eq(notificationDeliveries.id, deliveryId),
            ),
          )
          .returning();

        const row = updated[0];
        if (row === undefined) {
          throw new InvariantError({ message: '上报触达结果后数据库未返回记录' });
        }
        return toNotificationDelivery(row);
      });
    },
  };
}
