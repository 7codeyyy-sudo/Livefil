/**
 * 例程与步骤（ROUTINE-001，《数据库设计》§4.7、接口 §8）。
 *
 * 实例化口径（2026-09-21 冻结）：**物化**——「安排例程到某日」按步骤顺序
 * 展开为 schedule_blocks（source='routine'，回填 routine_id/routine_step_id
 * 溯源）；改定义（PATCH 模板）不重写已生成的块（FR-033：规则变更不篡改历史）。
 */
import { ValidationError } from '@/shared/errors/app-error.ts';

import { parseRecurrenceRule, type RecurrenceRule } from '../../scheduling/domain/recurrence';

export const ROUTINE_NAME_MAX_LENGTH = 160;
export const ROUTINE_STEP_TITLE_MAX_LENGTH = 240;
export const ROUTINE_STEPS_MAX = 20;

/** 步骤无预估时长时的展开时长（分钟）。 */
export const DEFAULT_STEP_MINUTES = 15;

/** 例程实体。 */
export interface Routine {
  readonly id: string;
  readonly userId: string;
  readonly lifeAreaId: string | null;
  readonly name: string;
  readonly recurrenceRule: RecurrenceRule;
  /** `HH:MM`；安排时的默认起点。 */
  readonly anchorTime: string | null;
  readonly timezone: string;
  readonly deletedAt: string | null;
  /** 创建时刻（ISO）：规则的展开锚点日。 */
  readonly createdAt: string;
  readonly version: number;
}

/** 例程步骤实体。 */
export interface RoutineStep {
  readonly id: string;
  readonly userId: string;
  readonly routineId: string;
  readonly title: string;
  readonly position: number;
  readonly estimatedMinutes: number | null;
  readonly minimumVersion: string | null;
  readonly version: number;
}

/** 例程 + 有序步骤（读模型的最小聚合）。 */
export interface RoutineDetail {
  readonly routine: Routine;
  readonly steps: readonly RoutineStep[];
}

export interface RoutineStepInput {
  readonly title: string;
  readonly estimatedMinutes: number | null;
  readonly minimumVersion: string | null;
}

/** 创建输入（字段级格式由 Zod 挡，跨字段规则在这里）。 */
export interface RoutineCreateInput {
  readonly name: string;
  readonly lifeAreaId: string | null;
  readonly recurrenceRule: unknown;
  readonly anchorTime: string | null;
  readonly timezone: string;
  readonly steps: readonly RoutineStepInput[];
}

export interface RoutinePatch {
  readonly name?: string | undefined;
  readonly lifeAreaId?: string | null | undefined;
  readonly recurrenceRule?: unknown;
  readonly anchorTime?: string | null | undefined;
  readonly timezone?: string | undefined;
}

/**
 * 步骤补丁语义（接口 §8 PATCH）：带 `id` 者更新、不带者新增、**缺失者软删**；
 * position 由最终数组顺序重排（必须从 0 连续）。
 */
export interface RoutineStepPatch {
  readonly id?: string | undefined;
  readonly title?: string | undefined;
  readonly estimatedMinutes?: number | null | undefined;
  readonly minimumVersion?: string | null | undefined;
}

/** 校验例程输入（规则结构与步骤集合）。 */
export function assertRoutineInput(input: {
  readonly recurrenceRule: unknown;
  readonly steps: readonly RoutineStepInput[];
}): RecurrenceRule {
  const rule = parseRecurrenceRule(input.recurrenceRule);
  if (input.steps.length < 1) {
    throw new ValidationError('例程至少需要一个步骤');
  }
  if (input.steps.length > ROUTINE_STEPS_MAX) {
    throw new ValidationError(`例程最多 ${String(ROUTINE_STEPS_MAX)} 个步骤`);
  }
  return rule;
}
