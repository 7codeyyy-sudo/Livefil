/**
 * 提醒交付仓储端口（NOTIFY-002，《数据库设计文档》§4.12.2、接口文档 §16）。
 *
 * ## 为什么「物化」是仓储的方法而不是后台任务
 *
 * 冻结契约里**没有**任何"创建 delivery"的端点或定时任务（拍板 2 与"零新端点"），
 * 但 §16 `GET /notifications/pending` 必须返回 `status ∈ {pending, failed}` 的行——
 * 没有写入路径的行永远为空。总监预审批准的落法是**读时物化**：`GET pending` 读取时
 * 扫描本用户 `enabled` 规则、算出本次应触发时刻并补落 `pending` 行。
 *
 * 物化与「三类 `cancelled` 重分类」必须在**同一次读路径事务**内、**先作废后物化**：
 * 反过来的话，刚被关掉的规则会在同一次调用里又落一条新的 `pending`。
 */
import type {
  NotificationDelivery,
  NotificationDeliveryPage,
  ReportNotificationAttemptInput,
} from './notification-delivery.ts';
import type { NotificationDeliveryStatus } from './notification-delivery.ts';

/** 列表查询条件（接口 §16 `GET /notification-deliveries`）。 */
export interface ListNotificationDeliveriesOptions {
  readonly status?: NotificationDeliveryStatus | undefined;
  /** 仅看「未达上限、且 `next_retry_at` 非空」的可重试失败行。 */
  readonly onlyRetryable?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface NotificationDeliveryRepository {
  /**
   * 读时物化 + 三类 `cancelled` 重分类（同事务，**先作废后物化**）。
   *
   * 三类作废（§4.12.2「未触达即作废」）：
   * ① 规则被关闭（`enabled = false`）② 全局关闭（`users.reminder_enabled = false`）
   * ③ 目标已完成（任务已完成/已删、例程已删）。只作用于 `pending` 行，
   * `sent` / `failed` 是已触达事实，不可改写。
   *
   * @param now 服务端当前时刻（显式传入便于测试固定时钟）。
   */
  materializePending(userId: string, now: Date): Promise<void>;

  /**
   * 应用内待处理列表：`status ∈ {pending, failed}` 且未 `dismissed`，
   * 按等级降序（关键 > 普通 > 复盘）、同级按 `scheduled_for` 升序。
   *
   * `failed` **必须在列表内**——这正是 FR-071「通知失败时应用内仍应显示待处理提醒」
   * 的语义落点；`cancelled` 与已 dismiss 的行不出现。
   */
  listPending(userId: string): Promise<readonly NotificationDelivery[]>;

  /** 失败与重试查询（`GET /notification-deliveries`，按 `scheduled_for` 降序）。 */
  listByUser(
    userId: string,
    options: ListNotificationDeliveriesOptions,
  ): Promise<NotificationDeliveryPage>;

  /** 按 id 查（非本人 → `null`）。 */
  findById(userId: string, deliveryId: string): Promise<NotificationDelivery | null>;

  /**
   * 「已处理」出口：写 `dismissed_at`，**不改 `status`**。重复 dismiss 幂等（返回当前行）。
   *
   * @throws {NotFoundError} 非本人或不存在时。
   */
  dismiss(userId: string, deliveryId: string, now: Date): Promise<NotificationDelivery>;

  /**
   * 触达尝试结果上报（接口 §16 第 8 端点，服务端为唯一权威）。
   *
   * 派生：`sent`→三置空；`failed`→`error_code` 取提交值、`attempt_count` +1、
   * `last_attempt_at` = now、`next_retry_at` 按三分支计算；两者**都**把 `channel`
   * 翻为 `browser`（第 6 条派生规则——渠道枚举的 `browser` 值由此获得唯一写入路径）。
   *
   * @param random 随机源（退避 jitter 用；显式注入以便测试）。
   * @throws {NotFoundError} 非本人或不存在时。
   * @throws {ConflictError} 对终态行（`sent` / `cancelled`）或已达上限的 `failed` 行上报时。
   */
  reportAttempt(
    userId: string,
    deliveryId: string,
    input: ReportNotificationAttemptInput,
    now: Date,
    random?: () => number,
  ): Promise<NotificationDelivery>;
}
