/**
 * 超时 + 重试执行包装（AI-003，RD-20260929-006 §1.3）。
 *
 * ## 为什么是「装饰器」而不是把逻辑塞进每个适配器
 *
 * 超时与重试是**横切策略**，与「哪家供应商、什么鉴权头」无关。做成实现同一端口的
 * 装饰器后，适配器只负责「发一次请求、把错误体翻译成我们的错误类」，策略只写一遍；
 * 换适配器不动策略，调策略不动适配器。
 *
 * ## 重试纪律（本文件的重点）
 *
 * 只对 `DependencyUnavailableError`（供应商不可用 / 网络失败 / 5xx）重试，
 * 且**最多 2 次额外重试**：
 *
 * - **429 不重试**——限流下重试会构成重试风暴（详设 §6.2「不能使用无上限的队列和重试」），
 *   上游正是要你慢下来，再试只是加压；由用户显式重试。
 * - **504 不重试**——超时重试会放大供应商压力，且第一次已经等满一个超时窗口。
 *
 * 退避为「指数 × jitter」，并全程监听 `AbortSignal`：调用方取消时，退避中的
 * `setTimeout` 必须立刻结束，否则取消会被拖到退避结束才生效。
 */
import { DependencyTimeoutError, DependencyUnavailableError } from '@/shared/errors/app-error.ts';

import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
} from '../../domain/ai-provider.ts';

/** 额外重试次数上限（不含首次）。详设 §6.2「最多 2–3 次」取下界。 */
export const AI_RETRY_MAX_ATTEMPTS = 2;

/** 退避基数（毫秒）。 */
export const AI_RETRY_BASE_DELAY_MS = 500;

/** 退避倍率：500ms → 1000ms。 */
export const AI_RETRY_BACKOFF_FACTOR = 2;

/** 抖动幅度：`(0.8 + 0.4 × random())` ⇒ ±20%。 */
export const AI_RETRY_JITTER_RATIO = 0.4;

export interface ResilientAiProviderOptions {
  /** 被装饰的 provider。 */
  readonly provider: AiProvider;
  /** 额外重试上限；缺省 {@link AI_RETRY_MAX_ATTEMPTS}。 */
  readonly maxRetries?: number;
  /** 退避基数（毫秒）；缺省 {@link AI_RETRY_BASE_DELAY_MS}。 */
  readonly baseDelayMs?: number;
  /** 随机源；显式注入以便测试用确定序列断言退避区间。 */
  readonly random?: () => number;
}

/**
 * 第 n 次重试前的延迟（毫秒）：`base × 2^n × (0.8 + 0.4 × random())`。
 *
 * @param attempt 从 0 起算的重试序号。
 * @param baseDelayMs 退避基数。
 * @param random 随机源。
 */
export function aiRetryDelayMs(attempt: number, baseDelayMs: number, random: () => number): number {
  const base = baseDelayMs * AI_RETRY_BACKOFF_FACTOR ** attempt;
  const jitter = 1 - AI_RETRY_JITTER_RATIO / 2 + AI_RETRY_JITTER_RATIO * random();
  return Math.round(base * jitter);
}

/**
 * 可被取消的延时。
 *
 * @throws {DependencyTimeoutError} 等待期间信号被取消时——退避被取消意味着本次调用
 *   已经不可能在预算内完成，不能再假装它还能重试。
 */
function delayMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DependencyTimeoutError('AI 调用已取消'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DependencyTimeoutError('AI 调用已取消'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 包装 provider，为其加上单次调用的超时与「仅不可用」的有限重试。
 *
 * 超时取 `request.timeoutMs`（每次调用的预算，随请求传入），因此**每一次重试都
 * 重新计时**：把整条链共用一个预算会让「第一次就快超时」的重试立刻又超时。
 *
 * @param options 被装饰的 provider 与重试参数。
 * @returns 实现同一端口的新 provider（`name` 透传自被装饰者）。
 */
export function createResilientAiProvider(options: ResilientAiProviderOptions): AiProvider {
  const inner = options.provider;
  const maxRetries = options.maxRetries ?? AI_RETRY_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? AI_RETRY_BASE_DELAY_MS;
  const random = options.random ?? Math.random;

  return Object.freeze({
    name: inner.name,

    async complete(
      request: AiCompletionRequest,
      ctx: { signal: AbortSignal },
    ): Promise<AiCompletionResult> {
      // 无出口的 for：循环只经 return 或 throw 结束，`attempt` 递增与上限判断
      // 在 catch 里完成。写成 while(true) 会让 TS 认为函数可能无返回值。
      for (let attempt = 0; ; attempt += 1) {
        const timeoutSignal = AbortSignal.timeout(request.timeoutMs);
        const signal = AbortSignal.any([ctx.signal, timeoutSignal]);

        try {
          return await inner.complete(request, { signal });
        } catch (error) {
          // 超时信号触发时不重试（504 不重试）：统一归一为 DependencyTimeoutError。
          // 适配器契约：上游自己返回的 504 也必须映射成 `DependencyTimeoutError`，
          // 否则它会落进下面的可重试分支——重试策略认的是错误类，不是 HTTP 状态码。
          const failure = timeoutSignal.aborted
            ? new DependencyTimeoutError('AI 调用超时', { cause: error })
            : error;

          const retryable = failure instanceof DependencyUnavailableError;
          if (!retryable || attempt >= maxRetries) {
            throw failure;
          }

          await delayMs(aiRetryDelayMs(attempt, baseDelayMs, random), ctx.signal);
        }
      }
    },
  });
}
