/**
 * 提醒规则（NOTIFY-001，《数据库设计文档》§4.12.1、SRS FR-070、接口文档 §16）。
 *
 * ## 等级为什么在这里定义而不是在用例里现算
 *
 * `level` 是**派生、只读**字段（`task→normal` / `routine→critical` / `review→review`），
 * 它同时有三个消费方：创建时写库、列表响应回带、物化时快照进 `deliveries.level`。
 * 派生映射只写一遍，三个消费方才有唯一的准据；映射以 PM 补节 1 为唯一来源
 * （拍板 6），本文件只是它的可执行表达。
 */

/** 规则挂靠的对象类型（§4.12.1 `target_type`）。 */
export const NOTIFICATION_TARGET_TYPES = ['task', 'routine', 'review'] as const;

export type NotificationTargetType = (typeof NOTIFICATION_TARGET_TYPES)[number];

/** 是否受支持的 `target_type`（用于把数据库/入参的裸字符串收窄）。 */
export function isNotificationTargetType(value: string): value is NotificationTargetType {
  return (NOTIFICATION_TARGET_TYPES as readonly string[]).includes(value);
}

/** 重复口径（§4.12.1 `repeat_rule`）。 */
export const NOTIFICATION_REPEAT_RULES = ['none', 'daily', 'weekly'] as const;

export type NotificationRepeatRule = (typeof NOTIFICATION_REPEAT_RULES)[number];

export function isNotificationRepeatRule(value: string): value is NotificationRepeatRule {
  return (NOTIFICATION_REPEAT_RULES as readonly string[]).includes(value);
}

/** 三级通知等级（FR-071，PM 补节 1 的「关键 / 普通 / 复盘」）。 */
export const NOTIFICATION_LEVELS = ['critical', 'normal', 'review'] as const;

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export function isNotificationLevel(value: string): value is NotificationLevel {
  return (NOTIFICATION_LEVELS as readonly string[]).includes(value);
}

/**
 * `target_type` → 等级（**唯一准据**，PM 补节 1 / 拍板 6）。
 *
 * 写成 `Record<NotificationTargetType, …>` 而不是普通对象：将来新增对象类型时
 * 漏填会编译失败，而不是悄悄产出一条等级为 `undefined` 的规则。
 */
export const NOTIFICATION_LEVEL_BY_TARGET_TYPE: Readonly<
  Record<NotificationTargetType, NotificationLevel>
> = Object.freeze({
  task: 'normal',
  routine: 'critical',
  review: 'review',
});

/** 按对象类型派生等级（服务端唯一的等级来源）。 */
export function deriveNotificationLevel(targetType: NotificationTargetType): NotificationLevel {
  return NOTIFICATION_LEVEL_BY_TARGET_TYPE[targetType];
}

/**
 * 等级排序权重（小者优先）：面板「按等级降序」＝ 关键 > 普通 > 复盘。
 *
 * 与 `NOTIFICATION_LEVELS` 的声明顺序一致，但**不共用**它——枚举顺序是契约表达，
 * 排序权重是实现细节，把两者绑在一起会让"调整枚举书写顺序"意外改变排序。
 */
export const NOTIFICATION_LEVEL_RANK: Readonly<Record<NotificationLevel, number>> = Object.freeze({
  critical: 0,
  normal: 1,
  review: 2,
});

/** `remind_at` 的格式（`HH:MM:SS`，与 `users.quiet_hours_start` 的 `time` 同构）。 */
export const REMIND_AT_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

/** 是否为合法的 `HH:MM:SS` 本地时刻。 */
export function isRemindAt(value: string): boolean {
  return REMIND_AT_PATTERN.test(value);
}

/** 领域实体。时间戳一律 ISO 8601（UTC）字符串，与既有模块的实体口径一致。 */
export interface NotificationRule {
  readonly id: string;
  readonly userId: string;
  readonly targetType: NotificationTargetType;
  /** `task` / `routine` 为对象 id；`review` 恒为 `null`（不绑定实体）。 */
  readonly targetId: string | null;
  /** 用户时区下的本地时刻 `HH:MM:SS`。 */
  readonly remindAt: string;
  readonly repeatRule: NotificationRepeatRule;
  readonly allowQuietHours: boolean;
  readonly enabled: boolean;
  /** 服务端派生、只读。 */
  readonly level: NotificationLevel;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建规则的输入（已通过校验；`level` 由服务端派生，不在入参里）。 */
export interface NotificationRuleCreateInput {
  readonly targetType: NotificationTargetType;
  readonly targetId: string | null;
  readonly remindAt: string;
  readonly repeatRule: NotificationRepeatRule;
  readonly allowQuietHours: boolean;
}

/**
 * 更新规则的补丁。
 *
 * 值类型显式带 `| undefined`：项目启用了 `exactOptionalPropertyTypes`，
 * Zod 产出的可选字段天然含 `undefined`（同 `ExpenseCategoryPatch` 的理由）。
 * **`level` 不在其中**——它是服务端派生、只读。
 */
export interface NotificationRulePatch {
  readonly remindAt?: string | undefined;
  readonly repeatRule?: NotificationRepeatRule | undefined;
  readonly allowQuietHours?: boolean | undefined;
  readonly enabled?: boolean | undefined;
}

/** 列表分页结果（游标在响应 `meta` 里透传）。 */
export interface NotificationRulePage {
  readonly items: readonly NotificationRule[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}
