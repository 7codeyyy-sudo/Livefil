/**
 * AI 草稿领域类型（AI-003，《数据库设计文档》§4.13.1）。
 *
 * ## 三组枚举为什么各自独立、且不扩
 *
 * - `draft_type` 是**业务类型**（创建时确定、此后不可变），与《接口文档》§11 的
 *   四类生成端点一一对应；
 * - `status` 是**生命周期**（随动作迁移），五值；`draft_type` × `status` 不是
 *   笛卡尔积——任一类型依次经过 `pending` 与四个终态之一；
 * - `error_code` 是**草稿生成失败原因**，与《接口文档》§1.4 的 API 错误码
 *   **不同源**（DB §4.13.1）：把「模型输出非法 JSON」编码成 API 错误码，
 *   会让客户端把「这次生成没成功」当成「请求本身失败」去重试。
 */
import {
  DependencyTimeoutError,
  DependencyUnavailableError,
  RateLimitError,
} from '@/shared/errors/app-error.ts';

/** 草稿类型（§4.13.1 四值）。 */
export const AI_DRAFT_TYPES = [
  'task_breakdown',
  'schedule_suggestion',
  'expense_parse',
  'review_summary',
] as const;

export type AiDraftType = (typeof AI_DRAFT_TYPES)[number];

export function isAiDraftType(value: string): value is AiDraftType {
  return (AI_DRAFT_TYPES as readonly string[]).includes(value);
}

/** 草稿状态（§4.13.1 五值，不扩）。 */
export const AI_DRAFT_STATUSES = [
  'pending',
  'confirmed',
  'cancelled',
  'expired',
  'failed',
] as const;

export type AiDraftStatus = (typeof AI_DRAFT_STATUSES)[number];

export function isAiDraftStatus(value: string): value is AiDraftStatus {
  return (AI_DRAFT_STATUSES as readonly string[]).includes(value);
}

/** 草稿生成失败原因（§4.13.1 五值，与 §1.4 API 错误码不同源）。 */
export const AI_DRAFT_ERROR_CODES = [
  'AI_PROVIDER_TIMEOUT',
  'AI_PROVIDER_UNAVAILABLE',
  'AI_RATE_LIMITED',
  'AI_RESPONSE_INVALID',
  'AI_INTERNAL_ERROR',
] as const;

export type AiDraftErrorCode = (typeof AI_DRAFT_ERROR_CODES)[number];

export function isAiDraftErrorCode(value: string): value is AiDraftErrorCode {
  return (AI_DRAFT_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 把捕获到的异常归一为草稿的 `error_code`。
 *
 * 依据 RD-006 §1.3 的映射表：调用超时 → `AI_PROVIDER_TIMEOUT`；供应商不可用 /
 * 网络失败 / 5xx → `AI_PROVIDER_UNAVAILABLE`；命中额度或供应商 429 →
 * `AI_RATE_LIMITED`；其余一律 `AI_INTERNAL_ERROR`。
 *
 * 用 `instanceof` 而不是字符串匹配错误码：`instanceof` 漏掉分支时更显眼，
 * 而字符串一旦大小写或前缀写错不会有任何提示。
 *
 * 注意 `AI_RESPONSE_INVALID` **不由本函数产生**：它描述的是「调用成功但输出不合法」，
 * 那时并没有异常可映射，由校验层（AI-004~006）显式指定。
 */
export function toAiDraftErrorCode(error: unknown): AiDraftErrorCode {
  if (error instanceof DependencyTimeoutError) {
    return 'AI_PROVIDER_TIMEOUT';
  }
  if (error instanceof DependencyUnavailableError) {
    return 'AI_PROVIDER_UNAVAILABLE';
  }
  if (error instanceof RateLimitError) {
    return 'AI_RATE_LIMITED';
  }
  return 'AI_INTERNAL_ERROR';
}

/** 草稿实体。时间戳一律 ISO 8601（UTC）字符串。 */
export interface AiDraft {
  readonly id: string;
  readonly userId: string;
  readonly draftType: AiDraftType;
  /**
   * **脱敏后**输入的 `sha256`（`input_hash`；仅用于去重与追溯，原文不落库）。
   *
   * 口径依 RD-20260929-006 §1.4 第 3 条＝`sha256(归一化后的 sanitized_input)`，
   * 见 `ai-input-sanitizer.ts`（该文件的文件头记录了与 DB §4.13.1 列注释「脱敏前」
   * 的口径差与取舍）。
   */
  readonly inputHash: string;
  /** **脱敏后**的输入。 */
  readonly sanitizedInput: string;
  /** 结构化草稿；`status='failed'` 时允许为 null（CHECK 兜底）。 */
  readonly resultJson: unknown;
  readonly status: AiDraftStatus;
  readonly provider: string;
  readonly model: string;
  readonly expiresAt: string;
  /** `status='failed'` 时必填（CHECK 兜底）。 */
  readonly errorCode: AiDraftErrorCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * 新建草稿的入参。
 *
 * 字段刻意**全部必填**（含 `status` 与 `errorCode`，允许显式传 null）：
 * `exactOptionalPropertyTypes` 下「可选」会把「没传」与「传了 undefined」分成
 * 两种类型，调用方反而更难判断自己漏了什么。
 */
export interface NewAiDraft {
  readonly userId: string;
  readonly draftType: AiDraftType;
  readonly inputHash: string;
  readonly sanitizedInput: string;
  readonly resultJson: unknown;
  readonly status: AiDraftStatus;
  readonly provider: string;
  readonly model: string;
  readonly expiresAt: Date;
  readonly errorCode: AiDraftErrorCode | null;
}
