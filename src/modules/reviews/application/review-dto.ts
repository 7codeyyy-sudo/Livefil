/**
 * 复盘的对外 DTO 与请求校验（REVIEW-001~003，《接口文档》§10）。
 *
 * DTO 与校验同文件——两者描述同一个边界（HTTP 出入参），拆开会在改字段时只改一半。
 *
 * ## 周汇总为什么在这里适配而不是再查一遍
 *
 * UI 规范 B2 第 6 项明文规定「分类开销摘要」取 `GET /expense-summary` 的既有数据源，
 * 所以 `toWeeklyExpenseSummaries()` 把 `ExpenseRepository.summarize()` 的结果转成
 * 快照里的形状，而不是让复盘模块自己查一遍 `expenses`——同一份口径不做两遍。
 */
import { z } from 'zod';

import type { ExpenseSummary } from '../../expenses/domain/expense-repository.ts';
import { ENERGY_LEVELS, type EnergyLevel } from '../../execution/domain/execution-log.ts';
import {
  REVIEW_ADJUSTMENT_ACTIONS,
  REVIEW_ADJUSTMENT_TARGET_TYPES,
  isAllowedCombination,
  type AdjustmentAction,
  type AdjustmentPayload,
  type AdjustmentTargetType,
  type ReviewAdjustment,
} from '../domain/review-adjustment.ts';
import {
  REVIEW_ANSWER_KEYS,
  REVIEW_ANSWER_MAX_LENGTH,
  type Review,
  type ReviewAnswers,
} from '../domain/review.ts';
import type { DailyFacts } from '../domain/review-repository.ts';
import type {
  WeeklyExpenseSummary,
  WeeklyFacts,
  WeeklyGoalActions,
  WeeklyPlanActual,
  WeeklyRepeatedDeferral,
  WeeklyTaskStatusCounts,
} from '../domain/weekly-snapshot.ts';

/** 日复盘响应（`GET /reviews/daily/{date}`；`data` 为 null 时整个对象不出现）。 */
export interface DailyReviewDto {
  readonly date: string;
  readonly answers: ReviewAnswers | null;
  readonly energyLevel: EnergyLevel | null;
  /** 尚未保存过则为 `null`（事实摘要仍会返回，见接口 §10 的空态口径）。 */
  readonly version: number | null;
  readonly createdAt: string | null;
  readonly facts: DailyFactsDto;
}

/** 日复盘的事实摘要（UI 规范 B1 的「完成/未完成计数与偏差要点行」）。 */
export interface DailyFactsDto {
  readonly plannedMinutes: number;
  readonly actualMinutes: number;
  readonly completedCount: number;
  readonly uncompletedCount: number;
}

export function toDailyFactsDto(facts: DailyFacts): DailyFactsDto {
  return {
    plannedMinutes: facts.planActual.plannedMinutes,
    actualMinutes: facts.planActual.actualMinutes,
    completedCount: facts.completedCount,
    uncompletedCount: facts.uncompletedCount,
  };
}

/**
 * 组装日复盘响应。
 *
 * 入参用结构类型而不是 `DailyReviewView`：`manage-review` 会 import 本文件，
 * 反向再 import 它会形成循环——而这里真正需要的只是「复盘行 + 事实」两样。
 */
export function toDailyReviewDto(
  date: string,
  view: { readonly review: Review | null; readonly facts: DailyFacts },
): DailyReviewDto {
  return {
    date,
    answers: view.review?.answers ?? null,
    energyLevel: view.review?.energyLevel ?? null,
    version: view.review?.version ?? null,
    createdAt: view.review?.createdAt ?? null,
    facts: toDailyFactsDto(view.facts),
  };
}

/** 调整清单项（不透出 `reviewId`——所属周由路径决定，客户端无需知道）。 */
export interface ReviewAdjustmentDto {
  readonly id: string;
  readonly targetType: AdjustmentTargetType;
  readonly targetId: string;
  readonly action: AdjustmentAction;
  readonly payload: AdjustmentPayload;
  readonly createdAt: string;
}

export function toReviewAdjustmentDto(adjustment: ReviewAdjustment): ReviewAdjustmentDto {
  return {
    id: adjustment.id,
    targetType: adjustment.targetType,
    targetId: adjustment.targetId,
    action: adjustment.action,
    payload: adjustment.payload,
    createdAt: adjustment.createdAt,
  };
}

/** 周复盘响应（字段与《接口文档》§10 的示例一一对应）。 */
export interface WeeklyReviewDto {
  readonly weekStart: string;
  readonly planActual: WeeklyPlanActual;
  readonly taskStatusCounts: WeeklyTaskStatusCounts;
  readonly repeatedDeferrals: readonly WeeklyRepeatedDeferral[];
  readonly goalActions: readonly WeeklyGoalActions[];
  readonly expenseSummaries: readonly WeeklyExpenseSummary[];
  readonly adjustments: readonly ReviewAdjustmentDto[];
  /** 快照未物化（周未结束或本周首次访问前）为 `null`。 */
  readonly snapshotSchemaVersion: number | null;
}

/** 组装周复盘响应（事实与摘要都已是"该返回的那一份"——存量快照优先由用例决定）。 */
export function toWeeklyReviewDto(
  weekStart: string,
  view: {
    readonly review: Review | null;
    readonly facts: WeeklyFacts;
    readonly expenseSummaries: readonly WeeklyExpenseSummary[];
    readonly adjustments: readonly ReviewAdjustment[];
  },
): WeeklyReviewDto {
  return {
    weekStart,
    planActual: view.facts.planActual,
    taskStatusCounts: view.facts.taskStatusCounts,
    repeatedDeferrals: view.facts.repeatedDeferrals,
    goalActions: view.facts.goalActions,
    expenseSummaries: view.expenseSummaries,
    adjustments: view.adjustments.map(toReviewAdjustmentDto),
    snapshotSchemaVersion: view.review?.snapshotSchemaVersion ?? null,
  };
}

/**
 * 分类摘要 → 快照的「按币种分列」形状。
 *
 * 币种清单取自 `grandTotals`（该窗口内真实出现过的币种），每个币种下再取各分类的
 * 小计——没有该币种流水的分类**不进这一币种的 `byCategory`**（否则会凭空多出
 * 一堆 `"0"` 行）。`groupBy=category` 的分组键就是分类 id，不为 `null`。
 */
export function toWeeklyExpenseSummaries(summary: ExpenseSummary): readonly WeeklyExpenseSummary[] {
  return summary.grandTotals.map((grand) => ({
    currencyCode: grand.currencyCode,
    totalMinor: grand.totalMinor,
    byCategory: summary.groups.flatMap((group) => {
      if (group.key === null) {
        return [];
      }
      const total = group.totals.find((item) => item.currencyCode === grand.currencyCode);
      return total === undefined
        ? []
        : [{ categoryId: group.key, categoryName: group.label, totalMinor: total.totalMinor }];
    }),
  }));
}

/** 三问答案：空串与纯空白按未答处理（DB §4.11.1「空串按未答处理」）。 */
const answersSchema = z
  .object({
    completed: z.string().max(REVIEW_ANSWER_MAX_LENGTH).optional(),
    blocker: z.string().max(REVIEW_ANSWER_MAX_LENGTH).optional(),
    nextAdjustment: z.string().max(REVIEW_ANSWER_MAX_LENGTH).optional(),
  })
  .strict()
  .nullish();

/**
 * `PUT /reviews/daily/{date}` 请求体。
 *
 * 两处冻结口径落在这里：① 三键均可省略、空串按未答；② `answers` 与 `energyLevel`
 * **不可同时为空**（避免落一条全空行，「跳过今天」是纯前端行为、不落记录）。
 */
export const dailyReviewUpsertSchema = z
  .object({
    answers: answersSchema.transform(normalizeAnswers),
    energyLevel: z
      .enum(ENERGY_LEVELS)
      .nullish()
      .transform((value) => value ?? null),
  })
  .strict()
  .refine((value) => value.answers !== null || value.energyLevel !== null, {
    message: '至少填写一题或选择精力等级（两者都为空时不落记录）',
  });

export type DailyReviewUpsertRequest = z.infer<typeof dailyReviewUpsertSchema>;

/** 归一化：去空白、丢空串，全空返回 `null`（＝未答）。 */
function normalizeAnswers(
  value:
    | {
        readonly completed?: string | undefined;
        readonly blocker?: string | undefined;
        readonly nextAdjustment?: string | undefined;
      }
    | null
    | undefined,
): ReviewAnswers | null {
  if (value === null || value === undefined) {
    return null;
  }
  const answers: Partial<Record<(typeof REVIEW_ANSWER_KEYS)[number], string>> = {};
  for (const key of REVIEW_ANSWER_KEYS) {
    const raw = value[key];
    if (raw === undefined) {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed !== '') {
      answers[key] = trimmed;
    }
  }
  return Object.keys(answers).length === 0 ? null : answers;
}

const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: '日期格式应为 YYYY-MM-DD' });

/** 路径参数（日复盘的 `date`、周复盘的 `weekStart`）。 */
export const reviewDateParamSchema = z.object({ date: calendarDay }).strict();
export const reviewWeekStartParamSchema = z.object({ weekStart: calendarDay }).strict();

/**
 * `POST /reviews/weekly/{weekStart}/adjustments` 请求体。
 *
 * 动作与对象类型的组合、以及动作参数（`shorten` 的正整数分钟数、`defer` 的日历日）
 * 都在这里挡下：校验失败返回 422，不必等到领域层再发现。
 */
export const createAdjustmentSchema = z
  .object({
    targetType: z.enum(REVIEW_ADJUSTMENT_TARGET_TYPES),
    targetId: z.uuid(),
    action: z.enum(REVIEW_ADJUSTMENT_ACTIONS),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!isAllowedCombination(value.action, value.targetType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['action'],
        message: `动作 ${value.action} 不能作用于 ${value.targetType}`,
      });
    }
    if (value.action === 'shorten') {
      const minutes = value.payload.estimatedMinutes;
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes <= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload', 'estimatedMinutes'],
          message: '缩短动作需要正整数 estimatedMinutes',
        });
      }
    }
    if (value.action === 'defer') {
      const dueDate = value.payload.dueDate;
      if (typeof dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload', 'dueDate'],
          message: '延期动作需要 YYYY-MM-DD 格式的 dueDate',
        });
      }
    }
  });

export type CreateAdjustmentRequest = z.infer<typeof createAdjustmentSchema>;

/** 已校验的请求 → 领域 `payload`（形状已由 `superRefine` 保证）。 */
export function toAdjustmentPayload(
  action: AdjustmentAction,
  payload: Readonly<Record<string, unknown>>,
): AdjustmentPayload {
  if (action === 'shorten') {
    return { estimatedMinutes: payload.estimatedMinutes as number };
  }
  if (action === 'defer') {
    return { dueDate: payload.dueDate as string };
  }
  return {};
}
