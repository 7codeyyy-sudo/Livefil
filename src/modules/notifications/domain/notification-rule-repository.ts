/**
 * 提醒规则仓储端口（NOTIFY-001，《详细设计说明书》§（仓储依赖纪律））。
 *
 * 纪律与既有仓储相同：**每个方法都带 `userId`**（用户作用域是强制表达），
 * **非本人 id 一律 `null` / `false`**（查询返 `null`、由用例转 `NotFoundError`，
 * 不泄露存在性——接口 §16 明文「不复用 403」）。
 *
 * ## 为什么有 `delete` 而生活领域/支出分类没有
 *
 * 那两处的"删除"语义是**停用**（保留历史关联可解析）；而接口 §16 为提醒规则
 * 显式定义了 `DELETE /notification-rules/{ruleId}`，其语义是**硬删**，且
 * 「已生成的交付记录保留」（`deliveries.rule_id` 置 NULL）——端口因此提供 `delete`。
 * FR-070 的「单条关闭」走 `update({ enabled: false })`，与硬删是两条不同的路径。
 */
import type {
  NotificationRule,
  NotificationRuleCreateInput,
  NotificationRulePage,
  NotificationRulePatch,
  NotificationTargetType,
} from './notification-rule.ts';

/** 列表查询条件（接口 §16 `GET /notification-rules`）。 */
export interface ListNotificationRulesOptions {
  readonly targetType?: NotificationTargetType | undefined;
  readonly targetId?: string | undefined;
  /** 不透明游标；首页不传。 */
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface NotificationRuleRepository {
  /** 列表（按 `created_at` 升序，游标不透明；排序键固定不开放参数）。 */
  listByUser(userId: string, options: ListNotificationRulesOptions): Promise<NotificationRulePage>;

  /** 按 id 查（非本人 → `null`）。 */
  findById(userId: string, ruleId: string): Promise<NotificationRule | null>;

  /**
   * 创建规则，`level` 由实现按 `targetType` **派生后写入**（客户端永不可写）。
   *
   * @throws {ConflictError} 同用户下 `(targetType, targetId, remindAt)` 已存在时。
   */
  create(userId: string, input: NotificationRuleCreateInput): Promise<NotificationRule>;

  /**
   * 更新可改字段（`remindAt` / `repeatRule` / `allowQuietHours` / `enabled`）。
   *
   * @throws {NotFoundError} 非本人或不存在时。
   * @throws {ConflictError} 改后与他条 `(targetType, targetId, remindAt)` 撞车时。
   */
  update(userId: string, ruleId: string, patch: NotificationRulePatch): Promise<NotificationRule>;

  /** 硬删（交付记录经 FK `ON DELETE SET NULL` 保留）。返回是否删到了行。 */
  delete(userId: string, ruleId: string): Promise<boolean>;
}
