/**
 * 时间块与固定事项实体（SCHED-001，《数据库设计》§4.6、§4.16）。
 *
 * 两个聚合放在同一个 domain 文件：冲突检测把它们绑成一个语义单元
 * （块的冲突对象就是固定事项实例），分开只会制造循环引用。
 */
import { ValidationError } from '@/shared/errors/app-error.ts';

/** 时间块实体。 */
export interface ScheduleBlock {
  readonly id: string;
  readonly userId: string;
  readonly taskId: string | null;
  readonly actionId: string | null;
  readonly routineId: string | null;
  readonly routineStepId: string | null;
  readonly startsAtUtc: Date;
  readonly endsAtUtc: Date;
  readonly timezone: string;
  readonly source: 'manual' | 'suggested' | 'imported' | 'routine';
  /** planned / active / completed / adjusted / cancelled。 */
  readonly status: 'planned' | 'active' | 'completed' | 'adjusted' | 'cancelled';
  /** none / warning / confirmed。 */
  readonly conflictState: 'none' | 'warning' | 'confirmed';
  readonly version: number;
}

/** 创建时间块的输入（归属校验由用例先行）。 */
export interface ScheduleBlockCreateInput {
  readonly taskId: string | null;
  readonly actionId: string | null;
  readonly startsAtUtc: Date;
  readonly endsAtUtc: Date;
  readonly timezone: string;
  readonly source: 'manual' | 'suggested' | 'imported' | 'routine';
  readonly routineId: string | null;
  readonly routineStepId: string | null;
}

/** 移动/修改的补丁（接口 §6 PATCH：字段同 POST、均可选）。 */
export interface ScheduleBlockPatch {
  readonly taskId?: string | null | undefined;
  readonly actionId?: string | null | undefined;
  readonly startsAtUtc?: Date | undefined;
  readonly endsAtUtc?: Date | undefined;
  readonly timezone?: string | undefined;
}

/** 校验时间窗（`ends > starts`，DB §4.6 约束的领域侧收口）。 */
export function assertBlockWindow(startsAtUtc: Date, endsAtUtc: Date): void {
  if (!(endsAtUtc.getTime() > startsAtUtc.getTime())) {
    throw new ValidationError('结束时间必须晚于开始时间');
  }
}

/**
 * PATCH 后的块状态（接口 §6：改动时间后 `planned` 转 `adjusted`；
 * `completed`/`cancelled` 不可移动）。
 */
export function blockStatusAfterPatch(
  current: ScheduleBlock,
  patch: ScheduleBlockPatch,
): ScheduleBlock['status'] {
  if (current.status === 'completed' || current.status === 'cancelled') {
    throw new ValidationError('已完成或已取消的时间块不可移动，请先恢复或重建');
  }
  const touchesTime =
    patch.startsAtUtc !== undefined ||
    patch.endsAtUtc !== undefined ||
    patch.timezone !== undefined;
  if (touchesTime && current.status === 'planned') {
    return 'adjusted';
  }
  return current.status;
}

/** 固定事项实体（三形态：单次 / 重复模板 / 重复实例）。 */
export interface FixedCommitment {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  /** 重复实例的溯源；单次事项为 NULL。 */
  readonly templateId: string | null;
  /** 实例行的归属日历日；模板行 NULL。 */
  readonly localDate: string | null;
  readonly startsAtUtc: Date | null;
  readonly endsAtUtc: Date | null;
  /** `HH:MM` 本地钟点；仅模板行有。 */
  readonly startsAtLocal: string | null;
  readonly durationMinutes: number;
  readonly timezone: string;
  /** 非空即模板行（结构同 §4.5）。 */
  readonly recurrenceRule: unknown;
  readonly deletedAt: string | null;
  /** 创建时刻（ISO）：重复模板的展开锚点（interval 从锚点日数起）。 */
  readonly createdAt: string;
  readonly version: number;
}

export const FIXED_TITLE_MAX_LENGTH = 240;

/** 校验固定事项创建输入的两形态（混用即 400，接口 §6）。 */
export function assertFixedCommitmentInput(input: {
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly startsAtLocal: string | null;
  readonly recurrenceRule: unknown;
  readonly durationMinutes?: number;
}): void {
  const singleForm = input.startsAt !== null || input.endsAt !== null;
  const templateForm = input.startsAtLocal !== null || input.recurrenceRule !== null;
  if (singleForm && templateForm) {
    throw new ValidationError('单次事项与重复模板不可混用：请只给一种形态');
  }
  if (!singleForm && !templateForm) {
    throw new ValidationError(
      '必须给出 startsAt/endsAt（单次）或 startsAtLocal/recurrenceRule（重复）',
    );
  }
  if (singleForm && (input.startsAt === null || input.endsAt === null)) {
    throw new ValidationError('单次事项必须同时给出开始与结束时间');
  }
  if (
    input.startsAt !== null &&
    input.endsAt !== null &&
    input.endsAt.getTime() <= input.startsAt.getTime()
  ) {
    throw new ValidationError('结束时间必须晚于开始时间');
  }
  if (templateForm) {
    if (input.startsAtLocal === null || input.recurrenceRule === null) {
      throw new ValidationError('重复模板必须同时给出 startsAtLocal 与 recurrenceRule');
    }
    if (input.durationMinutes === undefined || input.durationMinutes <= 0) {
      throw new ValidationError('重复模板必须给出正的时长（分钟）');
    }
  }
}
