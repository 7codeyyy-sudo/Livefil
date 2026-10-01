/**
 * AI 草稿接口封装（《UI 页面规范》§5 C/D，Phase 9；《接口文档》§11）。
 *
 * ## 为什么单独一层
 *
 * 与 `expense-api.ts` / `identity-api.ts` 同一条纪律：组件不拼 URL、不认识信封
 * 形状，七个 AI 端点集中在这里；路径只出现一处（拼错一个字符的表现是 404，而
 * 404 与"草稿不存在"在界面上长得几乎一样），返回类型显式标注成契约字段形状。
 *
 * ## 类型为什么在这里手写、不复用模块 DTO
 *
 * `src/modules/ai/application/ai-draft-dto.ts` 里的 DTO 是**服务端**的出入参描述
 * （还带 Zod schema）。页面消费只需要字段形状，手写一份最小的本地类型能把
 * 「客户端要用哪几个字段」讲清楚，也避免把服务端校验代码拖进客户端图。
 *
 * ## `status='failed'` 不是错误
 *
 * 生成端点按 §1.3 的口径在**生成失败**时返 **200 + 空载荷**（`suggestions: []` /
 * `draft: null` / `summary:{highlights:[],suggestions:[]}`）；只有 provider 故障
 * （超时 / 不可用 / 限流）才抛 504 / 502 / 429，由 `sendJson` 归一成
 * `ApiRequestError`。调用方据此分两条路：空载荷 → 空结果提示；`ApiRequestError`
 * → 「AI 暂不可用」错误行。
 */
import { fetchJson, sendJson } from './api-client';
import type { ApiEnvelope } from './api-client';

/** 草稿生命周期（《数据库设计文档》§4.13.1 五值）。 */
export type AiDraftStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'failed';

/** 一型：任务拆解建议（`task-breakdown`）。 */
export interface TaskBreakdownSuggestion {
  readonly title: string;
  readonly estimatedMinutes: number;
}

export interface TaskBreakdownDraftData {
  readonly draftId: string;
  readonly type: 'task_breakdown';
  readonly status: AiDraftStatus;
  readonly suggestions: readonly TaskBreakdownSuggestion[];
  readonly expiresAt: string;
}

/** 二型：排程建议（`schedule-suggestion`）。 */
export interface ScheduleSuggestionItem {
  readonly taskId: string;
  readonly blockStart: string;
  readonly blockEnd: string;
  readonly reason: string;
}

export interface ScheduleSuggestionDraftData {
  readonly draftId: string;
  readonly type: 'schedule_suggestion';
  readonly status: AiDraftStatus;
  readonly suggestions: readonly ScheduleSuggestionItem[];
  readonly expiresAt: string;
}

/** 三型：开销解析（`expense-parse`；`amountMinor` 为整数分）。 */
export interface ExpenseParseDraft {
  readonly amountMinor: number;
  readonly currencyCode: string;
  readonly occurredOn: string;
  readonly categoryId: string | null;
  readonly note: string | null;
}

export interface ExpenseParseDraftData {
  readonly draftId: string;
  readonly type: 'expense_parse';
  readonly status: AiDraftStatus;
  /** 生成失败时为 `null`。 */
  readonly draft: ExpenseParseDraft | null;
  readonly expiresAt: string;
}

/** 四型：周复盘摘要（`review-summary`）。 */
export interface ReviewSummaryText {
  readonly highlights: readonly string[];
  readonly suggestions: readonly string[];
}

export interface ReviewSummaryDraftData {
  readonly draftId: string;
  readonly type: 'review_summary';
  readonly status: AiDraftStatus;
  readonly summary: ReviewSummaryText;
  readonly expiresAt: string;
}

/* ------------------------------------------------------------------ */
/* 生成（四型各一端点）                                                  */
/* ------------------------------------------------------------------ */

export interface TaskBreakdownRequest {
  readonly text: string;
  readonly context?: { readonly availableMinutes?: number };
}

export function generateTaskBreakdown(
  input: TaskBreakdownRequest,
): Promise<ApiEnvelope<TaskBreakdownDraftData>> {
  return sendJson<TaskBreakdownDraftData>('POST', '/api/v1/ai/drafts/task-breakdown', input);
}

export interface ScheduleSuggestionRequest {
  readonly taskIds: readonly string[];
  readonly availableMinutes: number;
  readonly windowStart: string;
  readonly windowEnd: string;
}

export function generateScheduleSuggestion(
  input: ScheduleSuggestionRequest,
): Promise<ApiEnvelope<ScheduleSuggestionDraftData>> {
  return sendJson<ScheduleSuggestionDraftData>(
    'POST',
    '/api/v1/ai/drafts/schedule-suggestion',
    input,
  );
}

export function generateExpenseParse(input: {
  readonly text: string;
}): Promise<ApiEnvelope<ExpenseParseDraftData>> {
  return sendJson<ExpenseParseDraftData>('POST', '/api/v1/ai/drafts/expense-parse', input);
}

export interface ReviewSummaryRequest {
  readonly weekStart: string;
  readonly scope: { readonly includeTasks: boolean; readonly includeExpenses: boolean };
}

export function generateReviewSummary(
  input: ReviewSummaryRequest,
): Promise<ApiEnvelope<ReviewSummaryDraftData>> {
  return sendJson<ReviewSummaryDraftData>('POST', '/api/v1/ai/drafts/review-summary', input);
}

/* ------------------------------------------------------------------ */
/* 确认 / 取消（按 draftId 共用，无需分型）                              */
/* ------------------------------------------------------------------ */

/** 确认后可写入的业务实体 id。 */
export interface AiDraftConfirmResult {
  readonly draftId: string;
  readonly type: string;
  readonly status: AiDraftStatus;
  readonly createdIds: readonly string[];
}

/**
 * 确认要写入的开销（仅 `expense_parse` 需要）。
 *
 * §11 未定义该请求体（自选口径，见 `ai-draft-dto.ts`）：分类只能由用户在确认界面
 * 选定（模型不知道用户的分类 id），金额是用户核对过的值。
 */
export interface ExpenseConfirmInput {
  readonly categoryId: string;
  readonly amountMinor: number;
  readonly currencyCode?: string;
  readonly occurredOn?: string;
  readonly note?: string;
}

/**
 * 确认要写入的任务（仅 `task_breakdown` 需要）。
 *
 * 承载用户在草稿面板里编辑后的建议（UI 规范 §5 C1「可编辑、可移除单项」）；不给
 * 时服务端沿用草稿原值。`estimatedMinutes` 为 `null` 即「未填预计时长」。
 */
export interface TaskConfirmInput {
  readonly title: string;
  readonly estimatedMinutes: number | null;
}

/**
 * 确认请求体：两个分组各自只在对应草稿类型上有意义，均可省略。
 *
 * 其余两型（`schedule_suggestion` / `review_summary`）不带体——前者在 UI 上逐条
 * 走普通排程用例，后者不写入任何业务实体（UI 规范 §5 D）。
 */
export interface AiDraftConfirmBody {
  readonly expense?: ExpenseConfirmInput;
  readonly tasks?: readonly TaskConfirmInput[];
}

export function confirmAiDraft(
  draftId: string,
  body: AiDraftConfirmBody = {},
): Promise<ApiEnvelope<AiDraftConfirmResult>> {
  return sendJson<AiDraftConfirmResult>('POST', `/api/v1/ai/drafts/${draftId}/confirm`, body);
}

export interface AiDraftStatusResult {
  readonly draftId: string;
  readonly type: string;
  readonly status: AiDraftStatus;
}

export function cancelAiDraft(draftId: string): Promise<ApiEnvelope<AiDraftStatusResult>> {
  return sendJson<AiDraftStatusResult>('POST', `/api/v1/ai/drafts/${draftId}/cancel`);
}

/* ------------------------------------------------------------------ */
/* 用量（额度展示，本批不新增界面，仅备调用）                             */
/* ------------------------------------------------------------------ */

export interface AiUsageData {
  readonly periodStart: string;
  readonly resetAt: string;
  readonly callCount: number;
  readonly costMinor: number;
  readonly callLimit: number;
  readonly costLimitMinor: number;
  readonly remainingCalls: number;
  readonly remainingCostMinor: number;
}

export function fetchAiUsage(signal: AbortSignal): Promise<ApiEnvelope<AiUsageData>> {
  return fetchJson<AiUsageData>('/api/v1/ai/usage', signal);
}
