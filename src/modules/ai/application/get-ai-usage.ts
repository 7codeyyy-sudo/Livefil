/**
 * AI 用量查询用例（AI-006，`GET /ai/usage`，《接口文档》§11、RD-20260929-006 §1.5）。
 *
 * ## 「自然月」按**用户时区**切
 *
 * §1.5 明文：返回自然月按用户时区的已用次数 / 成本 / 剩余额度 / 重置时刻。
 * 周期计算与调用前的额度预检**共用** `ai-billing-period.ts` 的同一份实现——两处
 * 口径必须一致，否则会出现「展示的剩余额度」与「实际拦截点」对不上的情况。
 *
 * ## 只返回计数与金额，不返回任何内容
 *
 * 账本本身就不存 prompt / 模型输出（DB §4.13.2），这里也不去读草稿——响应里
 * 不可能出现用户内容（§11「不返回敏感 prompt」）。
 */
import { NotFoundError } from '@/shared/errors/app-error.ts';

import type { UserRepository } from '../../identity/domain/user-repository.ts';
import type { AiQuotaLimits } from '../domain/ai-policy.ts';
import type { AiUsageRepository } from '../domain/ai-usage-repository.ts';
import { resolveAiBillingPeriod } from './ai-billing-period.ts';

/** `GET /ai/usage` 的响应体（字段名为 §11 未定义处的**自选口径**）。 */
export interface AiUsageView {
  /** 本周期起点（用户时区当月 1 日 00:00 对应的 UTC 瞬时）。 */
  readonly periodStart: string;
  /** 下周期起点＝额度重置时刻（同口径）。 */
  readonly resetAt: string;
  readonly callCount: number;
  readonly costMinor: number;
  readonly callLimit: number;
  readonly costLimitMinor: number;
  readonly remainingCalls: number;
  readonly remainingCostMinor: number;
}

export interface GetAiUsageDependencies {
  readonly usage: AiUsageRepository;
  readonly users: UserRepository;
  readonly limits: AiQuotaLimits;
  readonly now: () => Date;
}

export class GetAiUsageUseCase {
  readonly #deps: GetAiUsageDependencies;

  constructor(dependencies: GetAiUsageDependencies) {
    this.#deps = dependencies;
  }

  /**
   * 读取当前用户在「用户时区自然月」内的已用额度与剩余额度。
   *
   * @throws {NotFoundError} 用户不存在时。
   */
  async execute(userId: string): Promise<AiUsageView> {
    const user = await this.#deps.users.findById(userId);
    if (user === null) {
      throw new NotFoundError('用户不存在');
    }

    const now = this.#deps.now();
    const { start: periodStart, resetAt } = resolveAiBillingPeriod(now, user.settings.timezone);

    const summary = await this.#deps.usage.summarize(userId, periodStart, now);

    return {
      periodStart: periodStart.toISOString(),
      resetAt: resetAt.toISOString(),
      callCount: summary.callCount,
      costMinor: summary.costMinor,
      callLimit: this.#deps.limits.monthlyCallLimit,
      costLimitMinor: this.#deps.limits.monthlyCostLimitMinor,
      // 剩余额度不呈现负数：已超限时给 0，避免客户端展示「-3 次」。
      remainingCalls: Math.max(0, this.#deps.limits.monthlyCallLimit - summary.callCount),
      remainingCostMinor: Math.max(0, this.#deps.limits.monthlyCostLimitMinor - summary.costMinor),
    };
  }
}
