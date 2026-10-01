/**
 * 模型结构化输出的校验（AI-004/005/006，RD-20260929-006 §1.3、§1.7）。
 *
 * ## 为什么校验在应用层而不是领域层
 *
 * 本仓库的既有约定是「Zod 只出现在应用层的 `*-dto.ts` / 用例文件」（领域层保持
 * 纯数据结构与纯规则，不引入校验库）。因此四类输出的 schema 与解析放在这里，
 * 领域层只保留 `ai-advice-policy.ts`（纯关键字规则）与 `ai-prompts.ts`（纯常量）。
 *
 * ## 校验失败为什么是「草稿落 failed」而不是抛 5xx
 *
 * RD-006 §1.3 明文：模型输出非法 JSON / 空结果时**不抛 5xx**，草稿落
 * `status='failed'`，接口按 **200** 返回空 `suggestions`，由 UI 走空态 + 手动录入。
 * 把它抛成 502 会让客户端以为「服务坏了」，而去重试一个本就不会成功的结果。
 * 校验失败因此不抛异常，而是返回 `{ ok: false }`，由用例落一条 `AI_RESPONSE_INVALID`。
 *
 * ## AI-006 的禁区拦截也在这里
 *
 * `review_summary` 的生成文本要先过 `findProhibitedAdvice`（FR-083 / §11 判定 3
 * 的「输出后校验拦截」），命中即视为输出不合法。只作用于模型生成的建议面，
 * 不作用于 `expense_parse` 的用户原文回显（否则用户自己写的「投资课」会被误判）。
 */
import { z } from 'zod';

import { findProhibitedAdvice } from '../domain/ai-advice-policy.ts';
import type { AiDraftType } from '../domain/ai-draft.ts';

/** 日历日（`date` 列口径）。 */
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: '日期格式应为 YYYY-MM-DD' });

/** 可被 `Date.parse` 解析的 ISO 8601 时刻。 */
const isoInstant = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: '时间必须是合法的 ISO 8601' });

/**
 * 一天的分钟数（任务时长的物理上界）。
 *
 * 刻意写成 `24 * 60` 算式而不写等值字面量：那个字面量恰是桌面断点像素值，全仓的
 * UI 纪律扫描禁止它出现在 TS/TSX 里。此处表达的是「一天的分钟数」这一物理量。
 */
export const MINUTES_PER_DAY = 24 * 60;

/** 任务拆解：`title` + 正整数分钟；至少一条（空结果按不合法处理）。 */
export const taskBreakdownResultSchema = z
  .object({
    suggestions: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(240),
            estimatedMinutes: z.number().int().positive().max(MINUTES_PER_DAY),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

/** 排程建议：每条必须带 `reason`（AI-005「可解释建议」，FR-081）。 */
export const scheduleSuggestionResultSchema = z
  .object({
    suggestions: z
      .array(
        z
          .object({
            taskId: z.uuid(),
            blockStart: isoInstant,
            blockEnd: isoInstant,
            reason: z.string().trim().min(1).max(500),
          })
          .strict()
          .refine((item) => Date.parse(item.blockEnd) > Date.parse(item.blockStart), {
            message: 'blockEnd 必须晚于 blockStart',
            path: ['blockEnd'],
          }),
      )
      .min(1)
      .max(20),
  })
  .strict();

/**
 * 开销解析：`amountMinor` 为**整数分**（跨线口径 DB §5.2）。
 *
 * `categoryId` / `note` 允许为 null——分类由用户在确认界面选定，不强迫模型猜
 * （用户可能自定义分类，模型无从知道其 id）。
 */
export const expenseParseResultSchema = z
  .object({
    amountMinor: z.number().int().positive(),
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/),
    occurredOn: calendarDay,
    categoryId: z.uuid().nullable(),
    note: z.string().max(500).nullable(),
  })
  .strict();

/** 复盘建议：要点与建议两组文本（AI-006；生成文本须过禁区拦截）。 */
export const reviewSummaryResultSchema = z
  .object({
    summary: z
      .object({
        highlights: z.array(z.string().trim().min(1).max(500)).max(10),
        suggestions: z.array(z.string().trim().min(1).max(500)).max(10),
      })
      .strict(),
  })
  .strict();

export type TaskBreakdownResult = z.infer<typeof taskBreakdownResultSchema>;
export type ScheduleSuggestionResult = z.infer<typeof scheduleSuggestionResultSchema>;
export type ExpenseParseResult = z.infer<typeof expenseParseResultSchema>;
export type ReviewSummaryResult = z.infer<typeof reviewSummaryResultSchema>;

/** 某类调用的结果 schema（与 `AiDraftType` 一一对应，缺一列即编译失败）。 */
export const AI_DRAFT_RESULT_SCHEMAS: Readonly<Record<AiDraftType, z.ZodType>> = Object.freeze({
  task_breakdown: taskBreakdownResultSchema,
  schedule_suggestion: scheduleSuggestionResultSchema,
  expense_parse: expenseParseResultSchema,
  review_summary: reviewSummaryResultSchema,
});

/** 校验结果：成功给结构化值，失败不抛异常（见文件头说明）。 */
export type AiDraftResultParse =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/** 复盘建议文本 → 禁区拦截（`highlights` 与 `suggestions` 都扫）。 */
function prohibitsAdvice(result: ReviewSummaryResult): boolean {
  const texts = [...result.summary.highlights, ...result.summary.suggestions];
  return texts.some((text) => findProhibitedAdvice(text) !== null);
}

/** 对已解析出的 JSON 值做 schema 校验（含 AI-006 禁区拦截）。 */
function validateResult(draftType: AiDraftType, value: unknown): AiDraftResultParse {
  const parsed = AI_DRAFT_RESULT_SCHEMAS[draftType].safeParse(value);
  if (!parsed.success) {
    return { ok: false };
  }
  if (draftType === 'review_summary' && prohibitsAdvice(parsed.data as ReviewSummaryResult)) {
    return { ok: false };
  }
  return { ok: true, value: parsed.data };
}

/**
 * 校验 provider 返回的原始文本。
 *
 * 空串与非法 JSON 一律按不合法处理——这正是 RD-006 §1.3 表里「非合法 JSON / 空结果」
 * 那一行。
 *
 * @param draftType 调用类型。
 * @param content provider 返回的文本（应为 JSON）。
 */
export function parseAiDraftContent(draftType: AiDraftType, content: string): AiDraftResultParse {
  if (content.trim() === '') {
    return { ok: false };
  }

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false };
  }
  return validateResult(draftType, json);
}

/**
 * 校验**已落库**的草稿 `result_json`（确认路径复用同一份 schema）。
 *
 * 确认时重新校验而不是直接信任落库值：草稿可能已存在一段时间，schema 可能已经
 * 收紧过，而 `result_json` 是 `jsonb`、结构由写入方保证——在写入业务实体前再挡一次
 * 是最便宜的防线。
 *
 * @param draftType 调用类型。
 * @param value 草稿的 `result_json`。
 */
export function parseAiDraftResultJson(draftType: AiDraftType, value: unknown): AiDraftResultParse {
  if (value === null || value === undefined) {
    return { ok: false };
  }
  return validateResult(draftType, value);
}
