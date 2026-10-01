/**
 * AI 调用用例（AI-003，《详细设计说明书》§4.5 第 1/4/5 步 + RD-20260929-006 §1.5）。
 *
 * 被 AI-004~006 复用的**唯一**AI 调用入口：草稿的生成、确认、取消都在它们各自
 * 的用例里，这里只负责「门禁 → 预检 → 调用 → 记账 → 日志」五件事。
 *
 * ## 为什么门禁必须在「选 provider、发请求」之前
 *
 * `ai_data_consent` 是用户对「数据出境」的授权。先调用后判断顺序错一次，
 * 数据就已经发出去了且不可撤回——所以判断放在最前面，且此时**不产生任何账**：
 * 无调用即无账（RD-006 §1.4）。
 *
 * ## 为什么依赖全部注入、函数体里不读 `process.env`
 *
 * 用例要能在不启动 Next.js、不连数据库的情况下被单元测试穷举（《概要设计》§10）。
 * 时钟、限流参数、超时、仓储、provider、logger 全部来自构造参数，测试才能把
 * 「同一时刻入账又预检」「退避一半被取消」这类边界稳定地复现出来。
 *
 * ## 不落 prompt、不落用户内容、不落模型原始输出
 *
 * 日志只写 `operation` / `errorCode` / `durationMs` / `provider` / `model` /
 * 用量字段（详设 §9 子集）。账本 `ai_usage` 同样不含内容（DB §4.13.2）。
 * 这是本用例的硬约束：任何一处把 `userContent` 或 `result.content` 带进日志，
 * 「记录用量但不记录敏感 prompt」就整体失效。
 */
import { ValidationError, toAppError } from '@/shared/errors/app-error.ts';
import type { Logger } from '@/shared/telemetry/logger.ts';

import {
  isMockProviderName,
  type AiCompletionRequest,
  type AiCompletionResult,
  type AiProvider,
  type AiRequestType,
} from '../domain/ai-provider.ts';
import { assertWithinAiQuota, type AiQuotaLimits } from '../domain/ai-policy.ts';
import type { NewAiUsageRecord } from '../domain/ai-usage.ts';
import type { AiUsageRepository } from '../domain/ai-usage-repository.ts';

/**
 * 短窗口限流的窗口长度（毫秒）。
 *
 * 口径是**滚动 60 秒**（`now - 60s` 到 `now` 之间的调用数），不是自然分钟。
 * 滚动窗口在整分钟边界上不会出现「59 秒内打满、下一秒又能打满」的成倍放行，
 * 与「每分钟上限」的保护意图一致；代价是记账表上要按 `created_at` 范围扫。
 */
const AI_RATE_WINDOW_MS = 60_000;

/**
 * 本月起点（UTC 自然月）。
 *
 * 已知取舍：契约要求「自然月，按用户时区」，而 AI-003 的用例依赖清单里没有时区
 * 来源。这里先按 UTC 取月首——它最多让月初/月末的几小时落到相邻月份；等到
 * `GET /ai/usage`（AI-006）需要展示重置时刻时，应把用户时区一并注入并统一两处口径。
 */
function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface InvokeAiProviderDependencies {
  /** provider 端口（已在组合根完成超时 + 重试包装）。 */
  readonly provider: AiProvider;
  readonly usage: AiUsageRepository;
  readonly logger: Logger;
  /** 时钟；注入后额度窗口与耗时在测试里完全确定。 */
  readonly now: () => Date;
  /** 单次调用超时（毫秒，来自 `AI_TIMEOUT_MS`）。 */
  readonly timeoutMs: number;
  /** 额度与限流上限（来自 env）。 */
  readonly limits: AiQuotaLimits;
  /**
   * 配置态模型名（来自 `AI_MODEL`）。
   *
   * **仅用于调用失败时的入账**：`ai_usage.model` 非空，而失败时拿不到
   * `result.model`（没有结果）。写入「本次本应使用的模型」比对不上时留空或臆造更如实。
   */
  readonly model: string;
}

export interface InvokeAiProviderInput {
  readonly userId: string;
  /** 当前用户的 AI 开关与数据发送同意（由路由从用户设置读出后传入）。 */
  readonly aiEnabled: boolean;
  readonly aiDataConsent: boolean;
  readonly requestType: AiRequestType;
  readonly systemPrompt: string;
  /** **已脱敏**的用户内容（脱敏属 AI-004）。 */
  readonly userContent: string;
  readonly maxOutputTokens: number;
}

export class InvokeAiProviderUseCase {
  readonly #provider: AiProvider;
  readonly #usage: AiUsageRepository;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #limits: AiQuotaLimits;
  readonly #model: string;

  constructor(dependencies: InvokeAiProviderDependencies) {
    this.#provider = dependencies.provider;
    this.#usage = dependencies.usage;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now;
    this.#timeoutMs = dependencies.timeoutMs;
    this.#limits = dependencies.limits;
    this.#model = dependencies.model;
  }

  /**
   * 执行一次 AI 调用。
   *
   * @throws {ValidationError} 未开启 AI 或未同意数据发送时（**在发请求之前**，不产生账）。
   * @throws {RateLimitError} 命中月度额度或短窗口上限时（**不发网络请求**）。
   * @throws {DependencyTimeoutError} 调用超时或超时信号触发时。
   * @throws {DependencyUnavailableError} 供应商不可用且重试耗尽时。
   */
  async execute(input: InvokeAiProviderInput): Promise<AiCompletionResult> {
    const startedAtMs = this.#now().getTime();

    this.#assertConsent(input);
    await this.#assertQuota(input.userId);

    const request: AiCompletionRequest = {
      requestType: input.requestType,
      systemPrompt: input.systemPrompt,
      userContent: input.userContent,
      maxOutputTokens: input.maxOutputTokens,
      timeoutMs: this.#timeoutMs,
    };

    // 每次调用一个取消作用域。AI-003 没有上游取消源，故本批它不会被触发；
    // AI-004~006 接入 HTTP 层后把「请求被取消」绑到它上面即可（端口已要求传 signal）。
    const signal = new AbortController().signal;

    let result: AiCompletionResult;
    try {
      result = await this.#provider.complete(request, { signal });
    } catch (error) {
      const appError = toAppError(error);
      // 失败也如实入账；记账自身出错时不覆盖原始的调用错误（只降级为错误日志）。
      await this.#recordFailure(input);
      this.#logger.error('AI 调用失败', {
        operation: 'ai_call',
        errorCode: appError.code,
        durationMs: this.#now().getTime() - startedAtMs,
        provider: this.#provider.name,
      });
      throw appError;
    }

    // 记账：真实 provider 成功记 `success`；mock 记 `skipped` 且不占额度（DB §4.13.2）。
    // 这一步的失败**不吞**：账写不进去却回报成功，会让额度上限形同虚设。
    await this.#usage.record({
      userId: input.userId,
      provider: result.provider,
      model: result.model,
      requestType: input.requestType,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCostMinor: result.estimatedCostMinor ?? 0,
      status: isMockProviderName(result.provider) ? 'skipped' : 'success',
    });

    this.#logger.info('AI 调用成功', {
      operation: 'ai_call',
      durationMs: this.#now().getTime() - startedAtMs,
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    return result;
  }

  /** 门禁：未同意数据发送 → 400，且**不写 `ai_usage`**（RD-006 §1.4 逐字）。 */
  #assertConsent(input: InvokeAiProviderInput): void {
    if (input.aiEnabled === true && input.aiDataConsent === true) {
      return;
    }
    this.#logger.warn('AI 调用被拒绝：未同意数据发送', {
      operation: 'ai_call',
      errorCode: 'VALIDATION_ERROR',
    });
    throw new ValidationError('未同意数据发送，无法使用 AI 功能', {
      fields: { aiDataConsent: '开启 AI 时必须同时同意数据发送' },
    });
  }

  /** 预检：命中任一上限则抛 `RateLimitError`，**不发网络请求**。 */
  async #assertQuota(userId: string): Promise<void> {
    const now = this.#now();
    const [monthly, recent] = await Promise.all([
      this.#usage.summarize(userId, startOfUtcMonth(now), now),
      this.#usage.summarize(userId, new Date(now.getTime() - AI_RATE_WINDOW_MS), now),
    ]);

    try {
      assertWithinAiQuota(
        {
          monthlyCallCount: monthly.callCount,
          monthlyCostMinor: monthly.costMinor,
          recentCallCount: recent.callCount,
        },
        this.#limits,
      );
    } catch (error) {
      this.#logger.warn('AI 额度已耗尽，调用被拒绝', {
        operation: 'ai_call',
        errorCode: toAppError(error).code,
      });
      throw error;
    }
  }

  /** 失败入账。入账失败只记日志——原始调用错误才是调用方需要看到的。 */
  async #recordFailure(input: InvokeAiProviderInput): Promise<void> {
    const failure: NewAiUsageRecord = {
      userId: input.userId,
      provider: this.#provider.name,
      model: this.#model,
      requestType: input.requestType,
      inputTokens: null,
      outputTokens: null,
      estimatedCostMinor: 0,
      status: 'failed',
    };

    try {
      await this.#usage.record(failure);
    } catch (recordError) {
      // 记账失败不往上抛：调用本身的结果比账本更重要，丢了这一步也还能交付草稿。
      // context 严格按 RD-20260929-006 §1.3 的字段白名单，平台侧错误码不进 context。
      this.#logger.error('AI 用量记账失败', {
        operation: 'ai_call',
        errorCode: toAppError(recordError).code,
      });
    }
  }
}
