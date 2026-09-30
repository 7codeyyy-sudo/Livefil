/**
 * 提醒交付记录（NOTIFY-002，《数据库设计文档》§4.12.2、接口文档 §16、SRS FR-071）。
 *
 * ## 四值状态与「已处理」为什么不扩枚举
 *
 * `status` 严守 `pending` / `sent` / `failed` / `cancelled` 四值（§4.12.2）。用户点了
 * 「已处理」只写 `dismissed_at`，**不改 status**——把「用户已处理」编码成第五个状态值，
 * 就再也无法区分"已处理的成功提醒"与"已处理的失败提醒"，而重试与失败留痕恰好依赖
 * 后者。`cancelled` 专指**未触达即作废**（规则关闭 / 全局关闭 / 目标已完成）。
 *
 * ## 重试纪律是本文件的重点
 *
 * 「发送失败必须记录错误码和下一次重试时间，不在无上限情况下重试」（§4.12 原文）与
 * 接口 §16 的「指数 + jitter」在这里落成常量与一个纯函数：退避公式只写一遍，
 * 仓储与测试消费同一份实现，不会出现"文档写 30s、代码写 60s"的漂移。
 */
import type { NotificationLevel, NotificationTargetType } from './notification-rule.ts';

/** 交付状态（§4.12.2，四值枚举，不扩）。 */
export const NOTIFICATION_DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'cancelled'] as const;

export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

export function isNotificationDeliveryStatus(value: string): value is NotificationDeliveryStatus {
  return (NOTIFICATION_DELIVERY_STATUSES as readonly string[]).includes(value);
}

/** 触达渠道（§4.12.2）：本批 `in_app` / `browser`；云端渠道留位（拍板 2）。 */
export const NOTIFICATION_CHANNELS = ['in_app', 'browser'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export function isNotificationChannel(value: string): value is NotificationChannel {
  return (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

/**
 * 触达失败原因（§4.12.2 四值）。
 *
 * **与接口文档 §1.4 的 API 错误码不同源**（RD-20260929-006 预审判定 3）：权限被拒与
 * 浏览器不支持本就不是服务端 API 错误，把它们塞进 §1.4 错误表会让客户端把"浏览器
 * 不给权限"当成"服务端调用失败"去重试。
 */
export const NOTIFICATION_ERROR_CODES = [
  'NOTIFICATION_PERMISSION_DENIED',
  'NOTIFICATION_UNSUPPORTED',
  'NOTIFICATION_CONSTRUCT_FAILED',
  'DELIVERY_INTERNAL_ERROR',
] as const;

export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_CODES)[number];

export function isNotificationErrorCode(value: string): value is NotificationErrorCode {
  return (NOTIFICATION_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 可重试的错误码（**瞬时**失败）。
 *
 * 另外两个（`NOTIFICATION_PERMISSION_DENIED` / `NOTIFICATION_UNSUPPORTED`）是
 * **确定性**失败：权限被拒与浏览器不支持不会因为再试一次而改变，重试只是骚扰用户
 * （RD-20260929-006 §2.3 的实测证据）。因此它们不计 `next_retry_at`。
 */
export const RETRYABLE_NOTIFICATION_ERROR_CODES = [
  'NOTIFICATION_CONSTRUCT_FAILED',
  'DELIVERY_INTERNAL_ERROR',
] as const satisfies readonly NotificationErrorCode[];

/** 该错误码是否值得重试。 */
export function isRetryableNotificationErrorCode(code: NotificationErrorCode): boolean {
  return (RETRYABLE_NOTIFICATION_ERROR_CODES as readonly string[]).includes(code);
}

/** 尝试次数硬上限（**含首次**），接口 §16「maxAttempts = 3」。 */
export const MAX_NOTIFICATION_ATTEMPTS = 3;

/** 退避基数（毫秒）：接口 §16「第 1 次约 30s±20%」。 */
export const NOTIFICATION_RETRY_BASE_DELAY_MS = 30_000;

/** 退避倍率：接口 §16「30s → 90s」，即每级 ×3。 */
export const NOTIFICATION_RETRY_BACKOFF_FACTOR = 3;

/** 抖动幅度：`(0.8 + 0.4 × random())` ⇒ ±20%。 */
export const NOTIFICATION_RETRY_JITTER_RATIO = 0.4;

/**
 * 第 n 次重试的延迟（毫秒）：`30s × 3^(n−1) × (0.8 + 0.4 × random())`。
 *
 * @param attemptCount 本次尝试后的 `attempt_count`（**已递增**）。
 * @param random 随机源；显式注入以便测试用确定序列断言退避区间。
 */
export function notificationRetryDelayMs(attemptCount: number, random: () => number): number {
  const exponent = Math.max(attemptCount, 1) - 1;
  const base = NOTIFICATION_RETRY_BASE_DELAY_MS * NOTIFICATION_RETRY_BACKOFF_FACTOR ** exponent;
  const jitter =
    1 - NOTIFICATION_RETRY_JITTER_RATIO / 2 + NOTIFICATION_RETRY_JITTER_RATIO * random();
  return Math.round(base * jitter);
}

/**
 * 服务端权威地计算 `next_retry_at`（接口 §16 派生第 5 条，三分支）。
 *
 * @param attemptCount 本次上报后的 `attempt_count`（已递增）。
 * @param errorCode 失败原因（`sent` 场景不调用本函数）。
 * @param now 本次上报时刻。
 * @param random 随机源（默认 `Math.random`）。
 * @returns 下次重试时刻；`null` 表示不再重试（不可重试失败 / 已达上限）。
 */
export function computeNextRetryAt(
  attemptCount: number,
  errorCode: NotificationErrorCode,
  now: Date,
  random: () => number = Math.random,
): Date | null {
  if (!isRetryableNotificationErrorCode(errorCode)) {
    return null;
  }
  if (attemptCount >= MAX_NOTIFICATION_ATTEMPTS) {
    return null;
  }
  return new Date(now.getTime() + notificationRetryDelayMs(attemptCount, random));
}

/** 客户端可上报的尝试结果（`pending` / `cancelled` 非客户端可写，接口 §16）。 */
export const NOTIFICATION_ATTEMPT_OUTCOMES = ['sent', 'failed'] as const;

export type NotificationAttemptOutcome = (typeof NOTIFICATION_ATTEMPT_OUTCOMES)[number];

/** 领域实体。时间戳一律 ISO 8601（UTC）字符串。 */
export interface NotificationDelivery {
  readonly id: string;
  readonly userId: string;
  /** 规则硬删后为 `null`（`ON DELETE SET NULL`，历史留痕保留）。 */
  readonly ruleId: string | null;
  readonly targetType: NotificationTargetType;
  readonly targetId: string | null;
  readonly channel: NotificationChannel;
  /** 触达时的等级**快照**，不随规则后续变更。 */
  readonly level: NotificationLevel;
  readonly status: NotificationDeliveryStatus;
  readonly scheduledFor: string;
  readonly attemptCount: number;
  readonly lastAttemptAt: string | null;
  readonly errorCode: NotificationErrorCode | null;
  readonly nextRetryAt: string | null;
  readonly dismissedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 列表分页结果。 */
export interface NotificationDeliveryPage {
  readonly items: readonly NotificationDelivery[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** 触达尝试上报（客户端只报事实，服务端派生一切）。 */
export interface ReportNotificationAttemptInput {
  readonly outcome: NotificationAttemptOutcome;
  /** `outcome = 'failed'` 时必有值；`sent` 时恒为 `null`。 */
  readonly errorCode: NotificationErrorCode | null;
}
