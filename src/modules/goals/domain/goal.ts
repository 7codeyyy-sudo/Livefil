/**
 * 目标与行动（GOAL-001/002，《数据库设计文档》§4.3、§4.4、《详细设计说明书》§3.2）。
 */
import { ValidationError } from '@/shared/errors/app-error.ts';

/** 目标状态（§4.3）。 */
export const GOAL_STATUSES = ['active', 'completed', 'paused', 'abandoned'] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** 行动状态（§4.4）——没有 abandoned：放弃属于目标层决策，行动只有停做与完成。 */
export const ACTION_STATUSES = ['active', 'completed', 'paused'] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** 名称长度上限（§4.3/§4.4 的 `varchar(160)`）。 */
export const GOAL_NAME_MAX_LENGTH = 160;

/**
 * 结果进度（`result_metric`，SRS FR-023）——**手动维护**的最小结构。
 *
 * 服务端不据 `current/target` 自动判定目标完成；比值只是展示。字段增减
 * 须规范升版（§4.3）。
 */
export interface ResultMetric {
  readonly current: number | null;
  readonly target: number | null;
  readonly unit: string | null;
  readonly note: string | null;
}

/** 目标实体。 */
export interface Goal {
  readonly id: string;
  readonly userId: string;
  readonly lifeAreaId: string | null;
  readonly name: string;
  readonly reason: string | null;
  readonly status: GoalStatus;
  readonly startDate: string | null;
  readonly targetDate: string | null;
  readonly resultMetric: ResultMetric | null;
  readonly version: number;
}

/** 行动实体。 */
export interface Action {
  readonly id: string;
  readonly userId: string;
  readonly goalId: string;
  readonly name: string;
  readonly minimumVersion: string | null;
  readonly targetFrequency: unknown;
  readonly estimatedMinutes: number | null;
  readonly status: ActionStatus;
  readonly deletedAt: string | null;
  readonly version: number;
}

/** 创建目标的输入（已通过校验）。 */
export interface GoalCreateInput {
  readonly name: string;
  readonly lifeAreaId: string | null;
  readonly reason: string | null;
  readonly targetDate: string | null;
}

/** 更新目标的补丁（接口文档 §5：名称、理由、日期、状态与 resultMetric）。 */
export interface GoalPatch {
  readonly name?: string | undefined;
  readonly reason?: string | null | undefined;
  readonly targetDate?: string | null | undefined;
  readonly status?: GoalStatus | undefined;
  readonly resultMetric?: ResultMetric | null | undefined;
}

/** 创建行动的输入（已通过校验）。 */
export interface ActionCreateInput {
  readonly name: string;
  readonly targetFrequency: unknown;
  readonly estimatedMinutes: number | null;
  readonly minimumVersion: string | null;
}

/** 更新行动的补丁（接口文档 §5：状态、频率、最低版本和预计时长）。 */
export interface ActionPatch {
  readonly status?: ActionStatus | undefined;
  readonly targetFrequency?: unknown;
  readonly minimumVersion?: string | null | undefined;
  readonly estimatedMinutes?: number | null | undefined;
}

/** 行动进度：由行动状态**汇总**得出（不是手填，也不能渲染成结果进度）。 */
export interface ActionProgress {
  readonly total: number;
  readonly completed: number;
  readonly active: number;
  readonly paused: number;
}

/** 校验 resultMetric 的最小结构（jsonb 进库前收口；字段增减须规范升版）。 */
export function assertResultMetric(value: unknown): ResultMetric {
  if (value === null || value === undefined) {
    throw new ValidationError('resultMetric 不能为空');
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('resultMetric 必须是对象');
  }
  const record = value as Record<string, unknown>;
  for (const key of ['current', 'target'] as const) {
    const raw = record[key];
    if (raw !== null && raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw))) {
      throw new ValidationError(`resultMetric.${key} 必须是数值或空`);
    }
  }
  for (const key of ['unit', 'note'] as const) {
    const raw = record[key];
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      throw new ValidationError(`resultMetric.${key} 必须是字符串或空`);
    }
  }
  return {
    current: (record.current as number | null | undefined) ?? null,
    target: (record.target as number | null | undefined) ?? null,
    unit: (record.unit as string | null | undefined) ?? null,
    note: (record.note as string | null | undefined) ?? null,
  };
}
