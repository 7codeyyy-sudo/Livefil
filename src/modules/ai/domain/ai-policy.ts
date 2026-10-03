/**
 * AI 额度与限流的纯判定（AI-003，RD-20260929-006 §1.5）。
 *
 * ## 为什么是纯函数
 *
 * 判定只依赖入参——已用额度、上限、短窗口计数。它不读 `process.env`、不查库、
 * 不看时钟：把「现在几点、用的是哪个时区、这个月从哪天算」这些会变的东西推给调用方，
 * 判定本身才能被穷举测试，也才不会在将来某次重构里悄悄改变口径。
 *
 * ## 双层层限流
 *
 * 月度额度（次数 + 成本）防「一个月用爆」；每分钟上限防**重试风暴**——
 * 一个不可用供应商会让客户端不断重试，只靠月度上限挡不住这种突发。
 * 两者命中都走同一个 `RateLimitError`（429），客户端按 §1.3 的降级动作处理。
 */
import { RateLimitError } from '@/shared/errors/app-error.ts';

/** 已用额度（由仓储按时间窗聚合得到；只统计 `status='success'`）。 */
export interface AiQuotaUsage {
  readonly monthlyCallCount: number;
  readonly monthlyCostMinor: number;
  /** 短窗口（一分钟）内的调用次数。 */
  readonly recentCallCount: number;
}

/** 额度上限（由 env 注入）。 */
export interface AiQuotaLimits {
  /** 每用户每月调用上限。 */
  readonly monthlyCallLimit: number;
  /** 每用户每月成本上限（整数分）。 */
  readonly monthlyCostLimitMinor: number;
  /** 每分钟请求上限。 */
  readonly perMinuteLimit: number;
}

/**
 * 判定是否仍在额度内；超限则抛 `RateLimitError`（429）。
 *
 * 判定顺序为「月度次数 → 月度成本 → 每分钟次数」：先报最宏观、最能说明问题的原因，
 * 客户端拿到的 `message` 才是可展示的（「本月调用次数已用完」比「请求过于频繁」有用）。
 *
 * @throws {RateLimitError} 任一上限触顶时。
 */
export function assertWithinAiQuota(usage: AiQuotaUsage, limits: AiQuotaLimits): void {
  if (usage.monthlyCallCount >= limits.monthlyCallLimit) {
    throw new RateLimitError('本月 AI 调用次数已达上限', {
      details: { limit: limits.monthlyCallLimit, used: usage.monthlyCallCount },
    });
  }
  if (usage.monthlyCostMinor >= limits.monthlyCostLimitMinor) {
    throw new RateLimitError('本月 AI 调用成本已达上限', {
      details: { limitMinor: limits.monthlyCostLimitMinor, usedMinor: usage.monthlyCostMinor },
    });
  }
  if (usage.recentCallCount >= limits.perMinuteLimit) {
    throw new RateLimitError('AI 调用过于频繁，请稍后重试', {
      details: { limit: limits.perMinuteLimit, used: usage.recentCallCount },
    });
  }
}
