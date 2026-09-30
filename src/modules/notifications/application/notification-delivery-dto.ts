/**
 * 提醒交付的对外 DTO 与请求校验（NOTIFY-002，接口文档 §16）。
 *
 * ## 三个 DTO 为什么长得很不一样
 *
 * 它们服务的读法不同，字段子集是契约给的、不是随手裁的：
 * - 待处理面板（`GET /notifications/pending`）只需要"能显示与跳转"的最小集：
 *   等级、状态、目标、失败原因、下次重试；
 * - 历史/失败查询（`GET /notification-deliveries`）要完整留痕：渠道、次数、时间线；
 * - 触达上报的回带（第 8 端点）刻意只回六个服务端权威字段，让客户端"看到自己改了什么"。
 */
import { z } from 'zod';

import {
  NOTIFICATION_ATTEMPT_OUTCOMES,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_ERROR_CODES,
  type NotificationDelivery,
} from '../domain/notification-delivery.ts';

/** `GET /notifications/pending` 的单项。 */
export interface PendingNotificationDto {
  readonly deliveryId: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly level: string;
  readonly status: string;
  readonly scheduledFor: string;
  readonly errorCode: string | null;
  readonly nextRetryAt: string | null;
}

export function toPendingNotificationDto(delivery: NotificationDelivery): PendingNotificationDto {
  return {
    deliveryId: delivery.id,
    targetType: delivery.targetType,
    targetId: delivery.targetId,
    level: delivery.level,
    status: delivery.status,
    scheduledFor: delivery.scheduledFor,
    errorCode: delivery.errorCode,
    nextRetryAt: delivery.nextRetryAt,
  };
}

/** `GET /notification-deliveries` 的单项。 */
export interface NotificationDeliveryDto {
  readonly deliveryId: string;
  readonly ruleId: string | null;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly channel: string;
  readonly level: string;
  readonly status: string;
  readonly scheduledFor: string;
  readonly attemptCount: number;
  readonly lastAttemptAt: string | null;
  readonly errorCode: string | null;
  readonly nextRetryAt: string | null;
  readonly dismissedAt: string | null;
  readonly createdAt: string;
}

export function toNotificationDeliveryDto(delivery: NotificationDelivery): NotificationDeliveryDto {
  return {
    deliveryId: delivery.id,
    ruleId: delivery.ruleId,
    targetType: delivery.targetType,
    targetId: delivery.targetId,
    channel: delivery.channel,
    level: delivery.level,
    status: delivery.status,
    scheduledFor: delivery.scheduledFor,
    attemptCount: delivery.attemptCount,
    lastAttemptAt: delivery.lastAttemptAt,
    errorCode: delivery.errorCode,
    nextRetryAt: delivery.nextRetryAt,
    dismissedAt: delivery.dismissedAt,
    createdAt: delivery.createdAt,
  };
}

/** 触达上报的服务端权威回带（第 8 端点响应）。 */
export interface NotificationAttemptResultDto {
  readonly deliveryId: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly lastAttemptAt: string | null;
  readonly errorCode: string | null;
  readonly nextRetryAt: string | null;
}

export function toNotificationAttemptResultDto(
  delivery: NotificationDelivery,
): NotificationAttemptResultDto {
  return {
    deliveryId: delivery.id,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    lastAttemptAt: delivery.lastAttemptAt,
    errorCode: delivery.errorCode,
    nextRetryAt: delivery.nextRetryAt,
  };
}

export const listNotificationDeliveriesQuerySchema = z
  .object({
    status: z.enum(NOTIFICATION_DELIVERY_STATUSES).optional(),
    // 只接受字面 `true`/`false`：`z.coerce.boolean()` 会把 `"false"` 也转成 true。
    onlyRetryable: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/**
 * 触达尝试上报（第 8 端点）：**仅两个客户端侧事实字段**。
 *
 * `.strict()` 让任何服务端权威字段（`status` / `attemptCount` / `channel` / `level` /
 * `scheduledFor` / `userId` / `ruleId` / `lastAttemptAt` / `nextRetryAt`）提交即 400，
 * 与 `level` 只读纪律同款——**不静默忽略**。
 */
export const reportNotificationAttemptSchema = z
  .object({
    outcome: z.enum(NOTIFICATION_ATTEMPT_OUTCOMES),
    errorCode: z.enum(NOTIFICATION_ERROR_CODES).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome === 'failed' && value.errorCode === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'outcome 为 failed 时必须提供 errorCode',
      });
    }
    if (value.outcome === 'sent' && value.errorCode !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'outcome 为 sent 时不得提供 errorCode',
      });
    }
  });

export type ListNotificationDeliveriesQuery = z.infer<typeof listNotificationDeliveriesQuerySchema>;
export type ReportNotificationAttemptRequest = z.infer<typeof reportNotificationAttemptSchema>;
