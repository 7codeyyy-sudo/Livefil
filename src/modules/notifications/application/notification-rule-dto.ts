/**
 * 提醒规则的对外 DTO 与请求校验（NOTIFY-001，接口文档 §16）。
 *
 * DTO 与校验放同一个文件——两者描述同一个边界（HTTP 出入参），拆开会让人改字段时只改一半。
 *
 * ## 两条服务端权威纪律在这里落成 `.strict()`
 *
 * - `level` **不接受客户端写入**：创建/更新 schema 都定义为 `.strict()`，客户端提交
 *   `level` 会因"未识别的键"得到 `VALIDATION_ERROR`（400）——而非静默忽略（§16 明文）。
 * - 触达上报的服务端权威字段（`status` / `attemptCount` / `channel` 等）同理，由
 *   `reportNotificationAttemptSchema` 的 `.strict()` 拦下。
 */
import { z } from 'zod';

import {
  NOTIFICATION_REPEAT_RULES,
  NOTIFICATION_TARGET_TYPES,
  REMIND_AT_PATTERN,
  type NotificationRule,
} from '../domain/notification-rule.ts';

/** 响应中的单项。`ruleId` 而非 `id`（§16 的字段名），刻意不透出 `userId`（由会话隐含）。 */
export interface NotificationRuleDto {
  readonly ruleId: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly remindAt: string;
  readonly repeatRule: string;
  readonly allowQuietHours: boolean;
  readonly enabled: boolean;
  readonly level: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toNotificationRuleDto(rule: NotificationRule): NotificationRuleDto {
  return {
    ruleId: rule.id,
    targetType: rule.targetType,
    targetId: rule.targetId,
    remindAt: rule.remindAt,
    repeatRule: rule.repeatRule,
    allowQuietHours: rule.allowQuietHours,
    enabled: rule.enabled,
    level: rule.level,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

/** `HH:MM:SS`——与 `users.quiet_hours_start/end` 的 `time` 类型同构。 */
const remindAtField = z.string().regex(REMIND_AT_PATTERN, { message: '提醒时间格式应为 HH:MM:SS' });

const uuidField = z.uuid();

/** `review` 不绑定实体（`targetId` 必须省略）；`task`/`routine` 必须提供 `targetId`。 */
function refineTargetId(
  value: { readonly targetType: string; readonly targetId?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.targetType === 'review') {
    if (value.targetId != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetId'],
        message: 'review 类提醒不绑定实体，targetId 必须省略',
      });
    }
    return;
  }
  if (value.targetId == null) {
    ctx.addIssue({
      code: 'custom',
      path: ['targetId'],
      message: 'task / routine 类提醒必须提供 targetId',
    });
  }
}

export const createNotificationRuleSchema = z
  .object({
    targetType: z.enum(NOTIFICATION_TARGET_TYPES),
    targetId: uuidField.nullish(),
    remindAt: remindAtField,
    repeatRule: z.enum(NOTIFICATION_REPEAT_RULES).default('none'),
    allowQuietHours: z.boolean().default(false),
  })
  .strict()
  .superRefine(refineTargetId);

/** 可改字段：`remindAt` / `repeatRule` / `allowQuietHours` / `enabled`（`level` 不在其列）。 */
export const updateNotificationRuleSchema = z
  .object({
    remindAt: remindAtField.optional(),
    repeatRule: z.enum(NOTIFICATION_REPEAT_RULES).optional(),
    allowQuietHours: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  // 空补丁是"成功但什么都没改"，用户以为保存了。明确拒绝。
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要提供一个要修改的字段' });

export const listNotificationRulesQuerySchema = z
  .object({
    targetType: z.enum(NOTIFICATION_TARGET_TYPES).optional(),
    targetId: uuidField.optional(),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type CreateNotificationRuleRequest = z.infer<typeof createNotificationRuleSchema>;
export type UpdateNotificationRuleRequest = z.infer<typeof updateNotificationRuleSchema>;
export type ListNotificationRulesQuery = z.infer<typeof listNotificationRulesQuerySchema>;
