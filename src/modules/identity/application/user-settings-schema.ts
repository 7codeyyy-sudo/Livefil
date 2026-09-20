/**
 * 设置更新的请求校验（IAM-002，《接口文档》§PATCH /me）。
 *
 * ## 只做字段级校验
 *
 * 跨字段约束（`aiEnabled=true` 要求 `aiDataConsent=true`）**不在这里**：那条规则
 * 依赖"用户当前已有的值"——补丁里可能只带 `aiEnabled`，而库里 `aiDataConsent`
 * 仍是 false。把这类规则塞进 schema 会得到一个只能看见补丁、看不见现状的校验器，
 * 于是必须靠调用方补上下文，反而更容易漏。它在用例层、读取现状之后执行。
 */
import { z } from 'zod';

import { SUPPORTED_LOCALES } from '@/shared/validation/locales.ts';

/**
 * 受支持的 IANA 时区集合。
 *
 * 用运行时能力推导而不是写死清单：时区数据库由运行环境提供（ICU/tzdata），
 * 写死的清单会随环境升级而过期，而"过期"的表现是拒绝一个用户实际上合法的时区。
 */
const SUPPORTED_TIME_ZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/** `HH:MM` 或 `HH:MM:SS`，24 小时制。 */
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

const quietHoursField = z
  .string()
  .regex(TIME_OF_DAY_PATTERN, '时间格式应为 HH:MM 或 HH:MM:SS（24 小时制）')
  .nullable();

/**
 * 更新设置的请求体。
 *
 * 所有字段可选（补丁语义），但 `version` **必需**：乐观并发的前提是客户端明确
 * 说明"我是基于哪个版本改的"。允许省略就等于允许"无条件覆盖"——那正是并发
 * 冲突要防的事。
 */
export const updateUserSettingsSchema = z
  .object({
    locale: z.enum(SUPPORTED_LOCALES).optional(),
    timezone: z
      .string()
      .refine((value) => SUPPORTED_TIME_ZONES.has(value), {
        message: '时区不在受支持的 IANA 时区列表内',
      })
      .optional(),
    currencyCode: z.string().regex(CURRENCY_CODE_PATTERN, '货币代码应为 3 位大写字母').optional(),
    weekStartsOn: z.number().int().min(0).max(6).optional(),
    defaultTaskDurationMinutes: z.number().int().positive().nullable().optional(),
    defaultBufferMinutes: z.number().int().min(0).nullable().optional(),
    aiEnabled: z.boolean().optional(),
    aiDataConsent: z.boolean().optional(),
    reminderEnabled: z.boolean().optional(),
    quietHoursStart: quietHoursField.optional(),
    quietHoursEnd: quietHoursField.optional(),
    // 显式逐个 `.optional()` 而不是 `partial()`：这里需要"除 version 外都可选"，
    // 而 partial 的掩码写法在不同版本里语义有差异；逐个标注让"哪些字段可选"
    // 在源码里一眼可见，不依赖读者记得掩码的含义。
    version: z.number().int().positive(),
  })
  /**
   * 拒绝未知字段。
   *
   * 不这么做的话，客户端拼错字段名（`currency` 而不是 `currencyCode`）会得到
   * 一个 200 与"什么都没改"的响应——用户以为保存成功了。明确报错比静默接受好。
   */
  .strict();

export type UpdateUserSettingsRequest = z.infer<typeof updateUserSettingsSchema>;
