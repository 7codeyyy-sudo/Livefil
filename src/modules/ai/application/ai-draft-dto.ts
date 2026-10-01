/**
 * AI 草稿的对外 DTO 与请求校验（AI-004/005/006，《接口文档》§11）。
 *
 * DTO 与校验同文件——两者描述同一个边界（HTTP 出入参），拆开会在改字段时只改一半
 * （与各模块既有的 `*-dto.ts` 一致）。
 *
 * ## 请求形状逐条对齐 §11
 *
 * 四个生成端点的请求体与 §11 示例一一对应，并用 `.strict()` 拒绝多余字段：
 * 「多发一个字段」既不该被静默忽略（客户端以为生效了），也不该透传进模型。
 *
 * ## 响应形状
 *
 * `data` 里的 `draftId` / `type` / `status` / `expiresAt` 由草稿实体直接透出；
 * 结构化载荷（`suggestions` / `draft` / `summary`）从 `result_json` 再解析一次——
 * `status='failed'` 时载荷为空集（§1.3：按 200 返回空 `suggestions`）。
 */
import { z } from 'zod';

import { EXPENSE_NOTE_MAX_LENGTH } from '../../expenses/domain/expense.ts';
import type { AiDraft, AiDraftStatus, AiDraftType } from '../domain/ai-draft.ts';
import {
  MINUTES_PER_DAY,
  expenseParseResultSchema,
  parseAiDraftResultJson,
  reviewSummaryResultSchema,
  scheduleSuggestionResultSchema,
  taskBreakdownResultSchema,
} from './ai-draft-result.ts';

/**
 * 用户自由文本的**硬上限**（字符数）。
 *
 * 与 `AI_MAX_INPUT_CHARS`（默认 2000）是两件事：后者是**脱敏后的截断长度**，
 * 这里是「请求体允许携带多少原文」的护栏，防的是超大正文打满内存。
 * 取一个比截断上限宽松的值，让「截断」而不是「400」成为超长输入的正常归宿。
 */
const AI_DRAFT_TEXT_MAX_LENGTH = 10_000;

const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: '日期格式应为 YYYY-MM-DD' });

const isoInstant = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: '时间必须是合法的 ISO 8601' });

/** `POST /ai/drafts/task-breakdown` 请求体（§11）。 */
export const taskBreakdownRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(AI_DRAFT_TEXT_MAX_LENGTH),
    context: z
      .object({ availableMinutes: z.number().int().positive().max(MINUTES_PER_DAY).optional() })
      .strict()
      .optional(),
  })
  .strict();

/** `POST /ai/drafts/schedule-suggestion` 请求体（§11；AI-005）。 */
export const scheduleSuggestionRequestSchema = z
  .object({
    taskIds: z.array(z.uuid()).min(1).max(20),
    availableMinutes: z.number().int().positive().max(MINUTES_PER_DAY),
    windowStart: isoInstant,
    windowEnd: isoInstant,
  })
  .strict()
  .refine((value) => Date.parse(value.windowEnd) > Date.parse(value.windowStart), {
    message: '时间窗的结束必须晚于开始',
    path: ['windowEnd'],
  });

/** `POST /ai/drafts/expense-parse` 请求体（§11；AI-006）。 */
export const expenseParseRequestSchema = z
  .object({ text: z.string().trim().min(1).max(AI_DRAFT_TEXT_MAX_LENGTH) })
  .strict();

/** `POST /ai/drafts/review-summary` 请求体（§11；AI-006）。 */
export const reviewSummaryRequestSchema = z
  .object({
    weekStart: calendarDay,
    scope: z
      .object({
        includeTasks: z.boolean().default(true),
        includeExpenses: z.boolean().default(false),
      })
      .strict(),
  })
  .strict()
  // 两个范围都关掉时没有任何数据可发，生成只会得到一段空建议——明确拒绝更诚实。
  .refine((value) => value.scope.includeTasks || value.scope.includeExpenses, {
    message: '至少选择一类要纳入复盘的数据范围',
    path: ['scope'],
  });

/** 草稿 id 路径参数（confirm / cancel）。 */
export const aiDraftIdParamSchema = z.object({ draftId: z.uuid() }).strict();

/**
 * `POST /ai/drafts/{draftId}/confirm` 的请求体（**§11 未定义**，自选口径）。
 *
 * ## 为什么需要请求体，且是「可选」的
 *
 * §11 只写了「确认后调用普通任务/行动用例写入正式数据」，没给请求形状。但两件事
 * 必须由**客户端在确认时给出**，模型给不出来：
 *
 * 1. FR-082 明文「金额写入前必须确认」——金额是用户在确认界面上核对过的值，
 *    与服务端草稿里的原值可能不同（用户改了）；
 * 2. 开销草稿的 `categoryId` 允许为 `null`（模型不知道用户的分类 id），而
 *    `expenses.category_id` 是 NOT NULL——分类只能由用户在确认界面选定。
 *
 * 因此 `expense` 分组只在确认 `expense_parse` 草稿时必填（其余类型可省略整个
 * 请求体）。`amountMinor` 缺省时沿用草稿值（用户没改）。
 *
 * 用 `/^[A-Z]{3}$/` 与 `calendarDay` 复刻 `expenseParseResultSchema` 的字段口径，
 * 避免「草稿校验一套、确认写入另一套」。
 */
export const aiDraftConfirmBodySchema = z
  .object({
    expense: z
      .object({
        categoryId: z.uuid(),
        amountMinor: z.number().int().positive().optional(),
        currencyCode: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{3}$/)
          .optional(),
        occurredOn: calendarDay.optional(),
        note: z.string().max(EXPENSE_NOTE_MAX_LENGTH).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AiDraftConfirmBody = z.infer<typeof aiDraftConfirmBodySchema>;

export type TaskBreakdownRequest = z.infer<typeof taskBreakdownRequestSchema>;
export type ScheduleSuggestionRequest = z.infer<typeof scheduleSuggestionRequestSchema>;
export type ExpenseParseRequest = z.infer<typeof expenseParseRequestSchema>;
export type ReviewSummaryRequest = z.infer<typeof reviewSummaryRequestSchema>;

/** 四类草稿响应的结构化载荷。 */
export interface TaskBreakdownSuggestionDto {
  readonly title: string;
  readonly estimatedMinutes: number;
}

export interface ScheduleSuggestionDto {
  readonly taskId: string;
  readonly blockStart: string;
  readonly blockEnd: string;
  readonly reason: string;
}

export interface ExpenseParseDraftDto {
  readonly amountMinor: number;
  readonly currencyCode: string;
  readonly occurredOn: string;
  readonly categoryId: string | null;
  readonly note: string | null;
}

export interface ReviewSummaryDto {
  readonly highlights: readonly string[];
  readonly suggestions: readonly string[];
}

/**
 * 生成端点的响应（§11）。
 *
 * 判别字段为 `type`，四种载荷互斥——与四个独立端点一一对应（案 B）。
 */
export type AiDraftResponseDto =
  | {
      readonly draftId: string;
      readonly type: 'task_breakdown';
      readonly status: AiDraftStatus;
      readonly suggestions: readonly TaskBreakdownSuggestionDto[];
      readonly expiresAt: string;
    }
  | {
      readonly draftId: string;
      readonly type: 'schedule_suggestion';
      readonly status: AiDraftStatus;
      readonly suggestions: readonly ScheduleSuggestionDto[];
      readonly expiresAt: string;
    }
  | {
      readonly draftId: string;
      readonly type: 'expense_parse';
      readonly status: AiDraftStatus;
      /** 生成失败（`status='failed'`）时为 `null`。 */
      readonly draft: ExpenseParseDraftDto | null;
      readonly expiresAt: string;
    }
  | {
      readonly draftId: string;
      readonly type: 'review_summary';
      readonly status: AiDraftStatus;
      /** 生成失败时为两个空数组。 */
      readonly summary: ReviewSummaryDto;
      readonly expiresAt: string;
    };

/**
 * 草稿实体 → 响应 DTO。
 *
 * `result_json` 为空（`status='failed'`）或再次校验失败时给空载荷，而不是 500：
 * §1.3 的冻结口径就是「失败按 200 返回空 `suggestions`」。
 */
export function toAiDraftResponseDto(draft: AiDraft): AiDraftResponseDto {
  const base = {
    draftId: draft.id,
    status: draft.status,
    expiresAt: draft.expiresAt,
  };
  const parsed = parseAiDraftResultJson(draft.draftType, draft.resultJson);

  if (draft.draftType === 'task_breakdown') {
    const result = parsed.ok ? taskBreakdownResultSchema.safeParse(parsed.value) : null;
    return {
      ...base,
      type: 'task_breakdown',
      suggestions: result?.success === true ? result.data.suggestions : [],
    };
  }
  if (draft.draftType === 'schedule_suggestion') {
    const result = parsed.ok ? scheduleSuggestionResultSchema.safeParse(parsed.value) : null;
    return {
      ...base,
      type: 'schedule_suggestion',
      suggestions: result?.success === true ? result.data.suggestions : [],
    };
  }
  if (draft.draftType === 'expense_parse') {
    const result = parsed.ok ? expenseParseResultSchema.safeParse(parsed.value) : null;
    return {
      ...base,
      type: 'expense_parse',
      draft: result?.success === true ? result.data : null,
    };
  }

  const result = parsed.ok ? reviewSummaryResultSchema.safeParse(parsed.value) : null;
  return {
    ...base,
    type: 'review_summary',
    summary: result?.success === true ? result.data.summary : { highlights: [], suggestions: [] },
  };
}

/**
 * 确认响应。
 *
 * §11 未给出 `confirm` 的响应形状，此处只承载「哪张草稿、变成什么状态、写入了哪些
 * 业务实体」——`createdIds` 让客户端能直接跳转到新建的任务 / 时间块 / 开销，
 * 不必再发一次列表请求（**自选口径**，已在交付报告中标注）。
 */
export interface AiDraftConfirmDto {
  readonly draftId: string;
  readonly type: AiDraftType;
  readonly status: AiDraftStatus;
  /** 确认后写入的业务实体 id；复盘建议无写入目标，故为空数组。 */
  readonly createdIds: readonly string[];
}

/** 取消响应（同样为 §11 未定义的**自选口径**）。 */
export interface AiDraftStatusDto {
  readonly draftId: string;
  readonly type: AiDraftType;
  readonly status: AiDraftStatus;
}

export function toCancelDto(draft: AiDraft): AiDraftStatusDto {
  return { draftId: draft.id, type: draft.draftType, status: draft.status };
}

/** 确认结果 → 响应 DTO（`createdIds` 由用例写出业务实体后带回）。 */
export function toConfirmDto(input: {
  readonly draft: AiDraft;
  readonly createdIds: readonly string[];
}): AiDraftConfirmDto {
  return {
    draftId: input.draft.id,
    type: input.draft.draftType,
    status: input.draft.status,
    createdIds: input.createdIds,
  };
}
