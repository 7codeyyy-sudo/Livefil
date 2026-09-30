/**
 * 提醒交付管理用例（NOTIFY-002，接口文档 §16）。
 *
 * ## 待处理列表为什么"读取即写"
 *
 * 冻结契约没有创建 delivery 的端点或定时任务，`GET /notifications/pending` 的行由
 * **读时物化**产生。因此这个用例的 `listPending` 不是一次纯读：它先让仓储在同一事务里
 * 作废旧条目、补落本次该触发的条目，再返回列表。路由层看到的仍是"一次 GET"。
 *
 * ## 触达上报是纯事实转交
 *
 * 客户端只报 `outcome` + `errorCode`；`attempt_count` / `next_retry_at` / 终态判定
 * 全在仓储（服务端唯一权威）里完成，用例不做二次推导。
 */
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import type { AuditEventType, AuditLogger } from '@/shared/telemetry/audit-event.ts';

import type {
  NotificationDelivery,
  NotificationDeliveryPage,
  ReportNotificationAttemptInput,
} from '../domain/notification-delivery.ts';
import type {
  ListNotificationDeliveriesOptions,
  NotificationDeliveryRepository,
} from '../domain/notification-delivery-repository.ts';

export interface ManageNotificationDeliveryDependencies {
  readonly notificationDeliveries: NotificationDeliveryRepository;
  readonly audit: AuditLogger;
}

export class ManageNotificationDeliveryUseCase {
  readonly #notificationDeliveries: NotificationDeliveryRepository;
  readonly #audit: AuditLogger;

  constructor(dependencies: ManageNotificationDeliveryDependencies) {
    this.#notificationDeliveries = dependencies.notificationDeliveries;
    this.#audit = dependencies.audit;
  }

  /**
   * 应用内待处理提醒：先物化（含三类作废），再取 `status ∈ {pending, failed}` 且未处理的行。
   *
   * @param now 服务端当前时刻（显式传入便于测试固定时钟）。
   */
  async listPending(userId: string, now: Date): Promise<readonly NotificationDelivery[]> {
    await this.#notificationDeliveries.materializePending(userId, now);
    return this.#notificationDeliveries.listPending(userId);
  }

  /** 失败与重试查询（`GET /notification-deliveries`）。 */
  listByUser(
    userId: string,
    options: ListNotificationDeliveriesOptions,
  ): Promise<NotificationDeliveryPage> {
    return this.#notificationDeliveries.listByUser(userId, options);
  }

  /** 「已处理」出口：写 `dismissed_at`、不改状态，重复调用幂等。 */
  async dismiss(
    userId: string,
    deliveryId: string,
    now: Date,
    requestId?: string,
  ): Promise<NotificationDelivery> {
    const dismissed = await this.#notificationDeliveries.dismiss(userId, deliveryId, now);
    this.#record('DATA_UPDATED', userId, requestId);
    return dismissed;
  }

  /** 触达尝试结果上报（第 8 端点）。 */
  async reportAttempt(
    userId: string,
    deliveryId: string,
    input: ReportNotificationAttemptInput,
    now: Date,
    random?: () => number,
    requestId?: string,
  ): Promise<NotificationDelivery> {
    const reported = await this.#notificationDeliveries.reportAttempt(
      userId,
      deliveryId,
      input,
      now,
      random,
    );
    this.#record('DATA_UPDATED', userId, requestId);
    return reported;
  }

  #record(type: AuditEventType, userId: string, requestId: string | undefined): void {
    this.#audit.record({
      type,
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
}
