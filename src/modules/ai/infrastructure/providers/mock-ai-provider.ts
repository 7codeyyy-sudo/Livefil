/**
 * Mock AI Provider（AI-003，RD-20260929-006 §1.2）。
 *
 * ## 为什么它是**长期资产**而不是过渡物
 *
 * 它进默认 `npm run check` 链与 CI：确定性、零网络、零密钥，因此「没有真实 key
 * 也能跑完整条链」。更重要的是——**降级路径必须可测**：超时、限流、不可用、空结果
 * 四条分支如果没有故障注入，就永远没有覆盖率（FR-084 末条明文要求处理这四种）。
 *
 * ## 为什么故障注入走构造参数而不是环境变量
 *
 * 环境变量是进程级的：一处设成 `timeout`，同一进程里所有正常路径一起被毒化。
 * 构造参数让故障只作用于「这一个 provider 实例」，测试可以同时持有正常实例与
 * 故障实例。
 *
 * ## 注入的故障必须抛**既有错误类**
 *
 * `DependencyTimeoutError` / `RateLimitError` / `DependencyUnavailableError` 是
 * 执行包装与用例共同识别的契约（RD-006 §1.3 映射表）。抛自定义错误会让降级分支
 * 在真实链路里走不到，测试就变成了假通过。
 */
import {
  DependencyTimeoutError,
  DependencyUnavailableError,
  RateLimitError,
} from '@/shared/errors/app-error.ts';

import {
  MOCK_PROVIDER_NAME,
  type AiCompletionRequest,
  type AiCompletionResult,
  type AiProvider,
  type AiRequestType,
} from '../../domain/ai-provider.ts';

/** 可注入的故障类型。`empty` 不抛错——它模拟「调用成功但没有任何建议」。 */
export const AI_MOCK_FAILURES = ['timeout', 'rate_limited', 'unavailable', 'empty'] as const;

export type AiMockFailure = (typeof AI_MOCK_FAILURES)[number];

export interface MockAiProviderOptions {
  /** 结果里回报的模型名；缺省 `mock`。真实装配下由 `AI_MODEL` 注入。 */
  readonly model?: string;
  readonly failure?: AiMockFailure;
}

/** 未指定模型时的名字。刻意与真实模型名区分，便于在日志里一眼认出 mock 调用。 */
const DEFAULT_MOCK_MODEL = MOCK_PROVIDER_NAME;

/**
 * 按调用类型返回的固定样例（内容形状对齐《接口文档》§11 的响应示例）。
 *
 * 固定字符串而不是随机生成：mock 的价值在于「同输入同输出」，随机化会让任何
 * 基于它的断言都变成概率断言。
 */
const SAMPLE_CONTENT_BY_REQUEST_TYPE: Readonly<Record<AiRequestType, string>> = Object.freeze({
  task_breakdown: JSON.stringify({
    suggestions: [
      { title: '整理汇报结构', estimatedMinutes: 20 },
      { title: '收集数据与图表', estimatedMinutes: 25 },
      { title: '撰写讲稿要点', estimatedMinutes: 15 },
    ],
  }),
  schedule_suggestion: JSON.stringify({
    suggestions: [
      {
        taskId: '00000000-0000-4000-8000-000000000000',
        blockStart: '2026-01-01T09:00:00.000Z',
        blockEnd: '2026-01-01T09:20:00.000Z',
        reason: '按预计时长排在可用时间窗最前（mock 固定样例）',
      },
    ],
  }),
  expense_parse: JSON.stringify({
    amountMinor: 3500,
    currencyCode: 'CNY',
    occurredOn: '2026-01-01',
    categoryId: null,
    note: null,
  }),
  review_summary: JSON.stringify({
    summary: {
      highlights: ['本周完成任务数较上周上升（mock 固定样例）'],
      suggestions: ['下周把优先级最高的任务安排在上午'],
    },
  }),
});

/**
 * 等待「信号被取消」或「超过超时」，两者先到者生效。
 *
 * 用它模拟超时而不是 `sleep(timeoutMs)`：真实的超时是 `AbortSignal` 驱动的，
 * 让 mock 也等同一个信号，才能顺带验证执行包装确实传了信号。
 */
function waitForAbortOrTimeout(signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * 创建 Mock provider。
 *
 * @param options 模型名与可注入故障。
 * @returns 冻结后的 provider。
 */
export function createMockAiProvider(options: MockAiProviderOptions = {}): AiProvider {
  const model = options.model ?? DEFAULT_MOCK_MODEL;
  const failure = options.failure;

  return Object.freeze({
    name: MOCK_PROVIDER_NAME,

    async complete(
      request: AiCompletionRequest,
      ctx: { signal: AbortSignal },
    ): Promise<AiCompletionResult> {
      if (failure === 'timeout') {
        await waitForAbortOrTimeout(ctx.signal, request.timeoutMs);
        throw new DependencyTimeoutError('AI 调用超时（mock 注入）');
      }

      // 调用方已取消：真实适配器会由 `fetch` 直接抛错，这里保持同一语义。
      if (ctx.signal.aborted) {
        throw new DependencyTimeoutError('AI 调用已取消（mock）');
      }

      if (failure === 'rate_limited') {
        throw new RateLimitError('AI 调用被限流（mock 注入）');
      }
      if (failure === 'unavailable') {
        throw new DependencyUnavailableError('AI 供应商不可用（mock 注入）');
      }

      return Object.freeze({
        content: failure === 'empty' ? '' : SAMPLE_CONTENT_BY_REQUEST_TYPE[request.requestType],
        provider: MOCK_PROVIDER_NAME,
        model,
        // mock 不产生真实用量与成本：报 null（未知）而不是臆造 0，账本上「未知」与
        // 「零成本」必须可区分（DB §4.13.2 对 `estimated_cost_minor` 的口径）。
        inputTokens: null,
        outputTokens: null,
        estimatedCostMinor: null,
      });
    },
  });
}
