/**
 * AI Provider 端口（AI-003，RD-20260929-006 §1.1 冻结契约）。
 *
 * ## 为什么是「协议适配」而不是「厂商适配」
 *
 * 适配维度取**协议**（OpenAI 兼容的 Chat Completions）而非厂商：DeepSeek、通义、
 * Kimi、本地 Ollama 都可对接同一个适配器。多一个厂商不等于多一个适配器，
 * 而多一个适配器就多一份超时/重试/错误体解析的维护面。
 *
 * ## 为什么 domain 只放接口，不放任何实现痕迹
 *
 * 领域层必须能脱离 Next.js 单独运行单元测试（《概要设计》§10）。因此本文件
 * **不 import `fetch`、不 import 任何基础设施**——`fetch` 在 Node 里是全局函数，
 * 一旦这里出现它的名字，领域与「怎么发请求」就绑死了，换实现要动领域。
 * 依赖边界由 `tests/unit/architecture/dependency-boundaries.test.ts` 静态拦截。
 */

/**
 * 调用类型：与《接口文档》§11 的四类草稿一一对应。
 *
 * 四个值既是「模型要写什么」，也是 `ai_usage.request_type` 的取值域
 * （DB §4.13.2），因此**不允许增删**——它是跨文档、跨表的共享枚举。
 */
export type AiRequestType =
  'task_breakdown' | 'schedule_suggestion' | 'expense_parse' | 'review_summary';

/** 调用入参。 */
export interface AiCompletionRequest {
  readonly requestType: AiRequestType;
  readonly systemPrompt: string;
  /** 已脱敏的用户内容（见 RD-006 §1.4），不得是原文。 */
  readonly userContent: string;
  readonly maxOutputTokens: number;
  /**
   * 本次调用的超时（毫秒）。
   *
   * 放进请求而不是塞进 provider 构造参数：超时是**每次调用的预算**，
   * 由用例按场景决定；把 provider 本身写成「永远 15000ms」，将来某个慢场景
   * 就只能再包一层。执行包装（`resilient-ai-provider.ts`）读的就是这个值。
   */
  readonly timeoutMs: number;
}

/** 调用结果。 */
export interface AiCompletionResult {
  readonly content: string;
  readonly provider: string;
  readonly model: string;
  /** 供应商未返回用量时为 null，**禁止臆造 0**——0 与「未知」在账本上必须可区分。 */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** 金额最小单位整数分；无报价时为 null（跨线口径，见 DB §5.2）。 */
  readonly estimatedCostMinor: number | null;
}

/**
 * Provider 端口。用例只依赖它，不依赖任何具体适配器。
 *
 * `ctx.signal` 是**调用方的取消/超时信号**（组合自请求超时与上游取消），
 * 实现方必须把它透传给 `fetch`；忽略它等于让超时形同虚设。
 */
export interface AiProvider {
  readonly name: string;
  complete(request: AiCompletionRequest, ctx: { signal: AbortSignal }): Promise<AiCompletionResult>;
}

/**
 * Mock provider 的名字。
 *
 * 与 `src/shared/validation/env.ts` 的 `MOCK_AI_PROVIDER` 同值（都是 `'mock'`）：
 * 共享层被依赖边界规则禁止反向依赖业务模块，无法复用同一个常量，故两处各写一次
 * ——改动任意一处都必须同时改另一处。用例据此判定「不占额度」（DB §4.13.2）。
 */
export const MOCK_PROVIDER_NAME = 'mock';

/** 是否为 mock provider（额度与计费口径的分叉点）。 */
export function isMockProviderName(name: string): boolean {
  return name === MOCK_PROVIDER_NAME;
}
