/**
 * 目标与行动的对外 DTO 与请求校验（GOAL-001/002，《接口文档》§5）。
 *
 * 与 task-dto.ts 同一个理由：DTO 与校验描述的是同一个边界（HTTP 出入参），
 * 拆开会让人在改字段时只改一半。
 */
import { z } from 'zod';

import {
  ACTION_STATUSES,
  GOAL_NAME_MAX_LENGTH,
  GOAL_STATUSES,
  type Action,
  type Goal,
  type ResultMetric,
} from '../domain/goal.ts';

/** 目标 DTO。 */
export interface GoalDto {
  readonly id: string;
  readonly lifeAreaId: string | null;
  readonly name: string;
  readonly reason: string | null;
  readonly status: string;
  readonly startDate: string | null;
  readonly targetDate: string | null;
  readonly resultMetric: ResultMetric | null;
  readonly version: number;
}

/** 行动 DTO。 */
export interface ActionDto {
  readonly id: string;
  readonly goalId: string;
  readonly name: string;
  readonly minimumVersion: string | null;
  readonly targetFrequency: unknown;
  readonly estimatedMinutes: number | null;
  readonly status: string;
  readonly version: number;
}

/** 目标详情 DTO：双进度分开（结果进度随目标、行动进度由行动汇总）。 */
export interface GoalDetailDto {
  readonly goal: GoalDto;
  readonly actions: readonly ActionDto[];
  readonly actionProgress: {
    readonly total: number;
    readonly completed: number;
    readonly active: number;
    readonly paused: number;
  };
  /** 关联开销（Phase 6 前恒为空集合——先立占位字段，避免详情响应将来变形状）。 */
  readonly expenses: readonly never[];
}

/**
 * 实体 → DTO。
 *
 * 刻意不透出 `userId`（会话隐含）与 `deletedAt`（软删细节，已删行动不出现在
 * 任何查询中）。
 */
export function toGoalDto(goal: Goal): GoalDto {
  return {
    id: goal.id,
    lifeAreaId: goal.lifeAreaId,
    name: goal.name,
    reason: goal.reason,
    status: goal.status,
    startDate: goal.startDate,
    targetDate: goal.targetDate,
    resultMetric: goal.resultMetric,
    version: goal.version,
  };
}

export function toActionDto(action: Action): ActionDto {
  return {
    id: action.id,
    goalId: action.goalId,
    name: action.name,
    minimumVersion: action.minimumVersion,
    targetFrequency: action.targetFrequency,
    estimatedMinutes: action.estimatedMinutes,
    status: action.status,
    version: action.version,
  };
}

/** 详情聚合 → DTO（`actionProgress` 由仓储聚合层随行带出，这里只透传）。 */
export function toGoalDetailDto(detail: {
  readonly goal: Goal;
  readonly actions: readonly Action[];
  readonly actionProgress: GoalDetailDto['actionProgress'];
}): GoalDetailDto {
  return {
    goal: toGoalDto(detail.goal),
    actions: detail.actions.map(toActionDto),
    actionProgress: detail.actionProgress,
    expenses: [],
  };
}

/** 名称：去首尾空白后校验非空与长度（§4.3/§4.4 的 `varchar(160)`）。 */
const entityName = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { message: '名称不能为空' })
  .refine((value) => value.length <= GOAL_NAME_MAX_LENGTH, {
    message: `名称不能超过 ${String(GOAL_NAME_MAX_LENGTH)} 个字符`,
  });

/** 日历日（YYYY-MM-DD）。 */
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: '日期格式应为 YYYY-MM-DD' });

const uuidField = z.uuid();

const optionalNullable = <T extends z.ZodType>(inner: T) => inner.nullish();

/**
 * resultMetric 的请求形状：字段与冻结结构一致，数值/文本类型先在这层挡住。
 * transform 把可省略键归一成完整 `ResultMetric`（补 null），让 schema 的输出
 * 直接可赋给 `GoalPatch.resultMetric`；领域里的 `assertResultMetric` 仍是
 * 校验的单一出口，用例层会再过一遍。
 */
const resultMetricInput = z
  .object({
    current: z.number().finite().nullish(),
    target: z.number().finite().nullish(),
    unit: z.string().max(40).nullish(),
    note: z.string().max(500).nullish(),
  })
  .strict()
  .transform((value) => ({
    current: value.current ?? null,
    target: value.target ?? null,
    unit: value.unit ?? null,
    note: value.note ?? null,
  }));

/** `POST /goals`：名称必填，其余可空（接口文档 §5）。 */
export const createGoalSchema = z
  .object({
    name: entityName,
    lifeAreaId: optionalNullable(uuidField),
    reason: optionalNullable(z.string().max(2000)),
    targetDate: optionalNullable(calendarDay),
  })
  .strict();

/** `PATCH /goals/{goalId}`：必带 `version`；状态与 resultMetric 就地更新。 */
export const updateGoalSchema = z
  .object({
    version: z.number().int().positive(),
    name: entityName.optional(),
    reason: optionalNullable(z.string().max(2000)),
    targetDate: optionalNullable(calendarDay),
    status: z.enum(GOAL_STATUSES).optional(),
    resultMetric: resultMetricInput.nullish(),
  })
  .strict();

/** `GET /goals` 查询参数（接口文档 §5：status / lifeAreaId / cursor / limit）。 */
export const listGoalsQuerySchema = z
  .object({
    status: z.enum(GOAL_STATUSES).optional(),
    lifeAreaId: uuidField.optional(),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/**
 * `POST /goals/{goalId}/actions`。
 *
 * `targetFrequency` 的**结构**接口文档给了示例（`{period, count}`）但没有冻结
 * 枚举集；jsonb 列在库层也不约束形状。这里只校验"是对象"，键值校验等规范
 * 冻结后再收紧——现在收太紧会把合法输入挡在门外。
 */
const targetFrequencyInput = z.record(z.string(), z.unknown());

export const createActionSchema = z
  .object({
    name: entityName,
    targetFrequency: targetFrequencyInput.nullish(),
    estimatedMinutes: optionalNullable(z.number().int().positive()),
    minimumVersion: optionalNullable(z.string().max(160)),
  })
  .strict();

/** `PATCH /actions/{actionId}`：必带 `version`。 */
export const updateActionSchema = z
  .object({
    version: z.number().int().positive(),
    status: z.enum(ACTION_STATUSES).optional(),
    targetFrequency: targetFrequencyInput.nullish(),
    minimumVersion: optionalNullable(z.string().max(160)),
    estimatedMinutes: optionalNullable(z.number().int().positive()),
  })
  .strict();
