/**
 * 执行记录与恢复模式（EXEC-001/002，《数据库设计》§4.8/§4.17、接口 §7）。
 *
 * 执行记录是**追加式**事实：没有 version、没有修改端点，重复提交由
 * Idempotency-Key 挡（重放 409）。与块/任务状态的联动是记录的副作用，
 * 规则收口在 `blockStatusForLog` / `taskStatusForLog` 两个纯函数上。
 */
import { ValidationError } from '@/shared/errors/app-error.ts';

/** 执行结果五枚举（2026-09-21 冻结；「最低版本完成」在执行记录层单列）。 */
export const EXECUTION_STATUSES = [
  'completed',
  'minimum_completed',
  'partial',
  'deferred',
  'skipped',
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** 原因码复用任务的冻结五值；仅 partial/deferred/skipped 可带（接口 §7）。 */
export const EXECUTION_REASON_CODES = [
  'NO_ENERGY',
  'NO_TIME',
  'CONFLICT',
  'TOO_HARD',
  'NOT_IN_MOOD',
] as const;

export type ExecutionReasonCode = (typeof EXECUTION_REASON_CODES)[number];

export const ENERGY_LEVELS = ['low', 'medium', 'high'] as const;
export type EnergyLevel = (typeof ENERGY_LEVELS)[number];

export const MOOD_SCORE_MIN = 1;
export const MOOD_SCORE_MAX = 5;

/** 执行记录实体（不可变快照）。 */
export interface ExecutionLog {
  readonly id: string;
  readonly userId: string;
  readonly taskId: string | null;
  readonly actionId: string | null;
  readonly scheduleBlockId: string | null;
  readonly status: ExecutionStatus;
  readonly plannedMinutes: number | null;
  readonly actualMinutes: number | null;
  readonly reasonCode: ExecutionReasonCode | null;
  readonly note: string | null;
  readonly energyLevel: EnergyLevel | null;
  readonly moodScore: number | null;
  /** 用户主张的发生时刻（支持回填补记）。 */
  readonly occurredAt: Date;
  readonly createdAt: string;
}

/** 记录输入（taskId 与 scheduleBlockId 至少给一个；归属校验由用例先行）。 */
export interface ExecutionLogCreateInput {
  readonly taskId: string | null;
  readonly actionId: string | null;
  readonly scheduleBlockId: string | null;
  readonly status: ExecutionStatus;
  readonly plannedMinutes: number | null;
  readonly actualMinutes: number | null;
  readonly reasonCode: ExecutionReasonCode | null;
  readonly note: string | null;
  readonly energyLevel: EnergyLevel | null;
  readonly moodScore: number | null;
  readonly occurredAt: Date;
}

/** 校验执行记录输入的横切约束（字段级格式由 Zod 挡，这里收口跨字段规则）。 */
export function assertExecutionLogInput(input: ExecutionLogCreateInput): void {
  // 习惯打卡（FR-030，2026-09-22 审查定档）允许 action-only：习惯没有
  // 任务与块载体，只有行动——三者至少其一即可。
  if (input.taskId === null && input.scheduleBlockId === null && input.actionId === null) {
    throw new ValidationError('执行记录必须关联任务、时间块或行动（至少一个）');
  }
  if (
    (input.status === 'partial' || input.status === 'deferred' || input.status === 'skipped') ===
      false &&
    input.reasonCode !== null
  ) {
    // completed / minimum_completed 是"做到了"，不解释为什么没做到。
    throw new ValidationError('只有部分完成、延期、跳过可以携带原因码');
  }
  if (input.actualMinutes !== null && input.actualMinutes < 0) {
    throw new ValidationError('实际时长不能为负数');
  }
}

/** 记录某状态时，关联块应进入的状态（完成/部分→completed；延跳→cancelled）。 */
export function blockStatusForLog(status: ExecutionStatus): 'completed' | 'cancelled' | null {
  if (status === 'completed' || status === 'minimum_completed' || status === 'partial') {
    return 'completed';
  }
  if (status === 'deferred' || status === 'skipped') {
    return 'cancelled';
  }
  return null;
}

/** 记录某状态时，关联任务应进入的任务状态（tasks 八枚举；最低版本不单列）。 */
export function taskStatusForLog(
  status: ExecutionStatus,
): 'completed' | 'partial' | 'deferred' | 'skipped' {
  switch (status) {
    case 'completed':
    case 'minimum_completed':
      return 'completed';
    case 'partial':
      return 'partial';
    case 'deferred':
      return 'deferred';
    case 'skipped':
      return 'skipped';
  }
}
