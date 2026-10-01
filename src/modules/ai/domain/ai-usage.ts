/**
 * AI 用量领域类型（AI-003，《数据库设计文档》§4.13.2）。
 *
 * ## 为什么是追加式账本，且没有 updatedAt
 *
 * `ai_usage` 只写不改（§4.13.2「追加式账本」）：它是「已经发生过的调用」的事实记录，
 * 事后修改等于篡改账。因此领域类型里也没有 id/时间戳之外的演化字段——
 * 需要修正时应当补一条新记录，而不是改旧记录。
 *
 * ## 为什么金额是整数分
 *
 * 浮点金额在累加时会漂移（0.1 + 0.2 ≠ 0.3），而额度判定恰好是一次累加比较。
 * 跨线口径（DB §5.2）统一用最小货币单位整数。
 */
import type { AiRequestType } from './ai-provider.ts';

/** 用量行状态（§4.13.2 三值）。 */
export const AI_USAGE_STATUSES = ['success', 'failed', 'skipped'] as const;

export type AiUsageStatus = (typeof AI_USAGE_STATUSES)[number];

export function isAiUsageStatus(value: string): value is AiUsageStatus {
  return (AI_USAGE_STATUSES as readonly string[]).includes(value);
}

/**
 * 一次调用产生的用量事实（不含用户）。
 *
 * 拆出「不含用户」的中间类型：`provider.complete()` 的返回值就落在这个形状上，
 * 由用例补上 `userId` 再入账——否则 provider 端口就要知道「这笔账记给谁」，
 * 而它本来只负责调用。
 */
export interface AiUsageFacts {
  readonly provider: string;
  readonly model: string;
  readonly requestType: AiRequestType;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedCostMinor: number;
  readonly status: AiUsageStatus;
}

/** 待写入 `ai_usage` 的一行。 */
export interface NewAiUsageRecord extends AiUsageFacts {
  readonly userId: string;
}

/**
 * 一个时间窗内的已用额度。
 *
 * **只统计 `status='success'`**（§4.13.2「Mock 不占额度，记 skipped」）：
 * mock 行与失败行都不消耗真实额度，否则本地开发与 CI 会耗尽生产口径的上限。
 */
export interface AiUsageSummary {
  readonly callCount: number;
  readonly costMinor: number;
}
