/**
 * 提醒规则管理用例（NOTIFY-001，接口文档 §16、SRS FR-070）。
 *
 * 与 `ManageExpenseUseCase` 同构：一个用例类收拢同一聚合的读写，注入仓储端口与审计器，
 * 路由层只表达 HTTP 形状。
 *
 * ## 关联实体的归属校验为什么不复用 404
 *
 * §16 明文：「`task`/`routine` 必须提供 `targetId` 且归属当前用户——不满足抛
 * `VALIDATION_ERROR`（400）」。这里照做（而非像关联查询那样用 404）：提醒规则是
 * **新建**偏好，用户选了一个不属于自己的对象属于请求内容不合法，与"资源不存在"的
 * 读路径语义不同。
 */
import { NotFoundError, ValidationError } from '@/shared/errors/app-error.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import type { AuditEventType, AuditLogger } from '@/shared/telemetry/audit-event.ts';

import type { RoutineRepository } from '../../routines/domain/routine-repository.ts';
import type { TaskRepository } from '../../tasks/domain/task-repository.ts';
import type {
  NotificationRule,
  NotificationRuleCreateInput,
  NotificationRulePage,
  NotificationRulePatch,
} from '../domain/notification-rule.ts';
import type {
  ListNotificationRulesOptions,
  NotificationRuleRepository,
} from '../domain/notification-rule-repository.ts';

export interface ManageNotificationRuleDependencies {
  readonly notificationRules: NotificationRuleRepository;
  readonly tasks: TaskRepository;
  readonly routines: RoutineRepository;
  readonly audit: AuditLogger;
}

export class ManageNotificationRuleUseCase {
  readonly #notificationRules: NotificationRuleRepository;
  readonly #tasks: TaskRepository;
  readonly #routines: RoutineRepository;
  readonly #audit: AuditLogger;

  constructor(dependencies: ManageNotificationRuleDependencies) {
    this.#notificationRules = dependencies.notificationRules;
    this.#tasks = dependencies.tasks;
    this.#routines = dependencies.routines;
    this.#audit = dependencies.audit;
  }

  list(userId: string, options: ListNotificationRulesOptions): Promise<NotificationRulePage> {
    return this.#notificationRules.listByUser(userId, options);
  }

  /** 单条读取：不存在 / 非本人一律抛 404（不泄露存在性）。 */
  findById(userId: string, ruleId: string): Promise<NotificationRule> {
    return this.#requireRule(userId, ruleId);
  }

  async create(
    userId: string,
    input: NotificationRuleCreateInput,
    requestId?: string,
  ): Promise<NotificationRule> {
    await this.#assertTarget(userId, input.targetType, input.targetId);

    const created = await this.#notificationRules.create(userId, input);
    this.#record('DATA_CREATED', userId, requestId);
    return created;
  }

  async update(
    userId: string,
    ruleId: string,
    patch: NotificationRulePatch,
    requestId?: string,
  ): Promise<NotificationRule> {
    // 先确认规则归属（不存在/非本人 → 404），再走仓储的冲突预检与更新。
    await this.#requireRule(userId, ruleId);
    const updated = await this.#notificationRules.update(userId, ruleId, patch);
    this.#record('DATA_UPDATED', userId, requestId);
    return updated;
  }

  async delete(userId: string, ruleId: string, requestId?: string): Promise<void> {
    const removed = await this.#notificationRules.delete(userId, ruleId);
    if (!removed) {
      throw new NotFoundError('提醒规则不存在');
    }
    this.#record('DATA_DELETED', userId, requestId);
  }

  /** `task`/`routine` 的对象必须存在且归属当前用户；`review` 不绑定实体，跳过。 */
  async #assertTarget(
    userId: string,
    targetType: NotificationRuleCreateInput['targetType'],
    targetId: string | null,
  ): Promise<void> {
    if (targetType === 'review') {
      return;
    }
    if (targetId === null) {
      // DTO 已拦下，这里是纵深防御：仓储不该收到一个没有对象 id 的 task/routine 规则。
      throw new ValidationError('task / routine 类提醒必须提供 targetId');
    }

    if (targetType === 'task') {
      const task = await this.#tasks.findById(userId, targetId);
      if (task === null) {
        throw new ValidationError('关联的任务不存在或不属于当前用户');
      }
      return;
    }

    const routine = await this.#routines.findDetail(userId, targetId);
    if (routine === null) {
      throw new ValidationError('关联的例程不存在或不属于当前用户');
    }
  }

  async #requireRule(userId: string, ruleId: string): Promise<NotificationRule> {
    const rule = await this.#notificationRules.findById(userId, ruleId);
    if (rule === null) {
      throw new NotFoundError('提醒规则不存在');
    }
    return rule;
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
