/**
 * 任务（TASK-001~003，《数据库设计文档》§4.5、《详细设计说明书》§3.1、SRS FR-010~012）。
 */
import { ValidationError } from '@/shared/errors/app-error.ts';

/**
 * 任务状态枚举（§4.5）。
 *
 * 「最低版本完成」**不单列枚举值**：它是"以最低版本完成"这一完成方式，
 * 落为 `completed` 并在状态事件里记录执行的是 `minimumVersion`——
 * 否则状态集会与 `completed` 永久重叠，每个消费状态的地方都要处理两义性。
 */
export const TASK_STATUSES = [
  'inbox',
  'planned',
  'in_progress',
  'completed',
  'partial',
  'deferred',
  'skipped',
  'archived',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * 完整合法流转表（《数据库设计》§4.5，2026-09-21 冻结）。
 *
 * SRS §9.1 只画了正向；这里补齐反向/重开。**表之外的跳转一律非法**
 * （`VALIDATION_ERROR`）——判定收敛在这一个常量上，流转规则就不会散落在
 * 各个用例里互相漂移。
 *
 * 两个刻意的约束：
 * - `inbox` 不能直接进 `in_progress`（SRS 要求先「已安排」）；
 * - `archived → archived`、`completed → completed` 等自环不合法
 *   （重复归档/重复完成不是幂等，是"没有发生状态变化"，调用方应收到明确错误
 *   而不是静默成功——后者会让用户以为操作生效了第二次）。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  inbox: ['planned', 'archived'],
  planned: ['in_progress', 'completed', 'partial', 'deferred', 'skipped', 'archived'],
  in_progress: ['planned', 'completed', 'partial', 'deferred', 'skipped', 'archived'],
  completed: ['planned', 'archived'],
  partial: ['in_progress', 'planned', 'completed', 'deferred', 'skipped', 'archived'],
  deferred: ['planned', 'archived'],
  skipped: ['planned', 'archived'],
  archived: ['inbox', 'planned'],
};

/**
 * 判定一次状态跳转是否合法。
 *
 * 收口成函数而不是让各用例各自查表：将来若流转规则变化（例如允许
 * `completed → in_progress`），只需要改表，不用追着每个调用点改判断。
 */
export function isTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** 校验并抛出结构化错误——用例层的流转判定统一走这里。 */
export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!isTaskTransition(from, to)) {
    throw new ValidationError(`任务不允许从「${from}」变更为「${to}」`);
  }
}

/** 跳过 / 部分完成时允许的原因码（接口文档 §4，冻结集合，开放扩展须规范升版）。 */
export const TASK_REASON_CODES = [
  'NO_ENERGY',
  'NO_TIME',
  'CONFLICT',
  'TOO_HARD',
  'NOT_IN_MOOD',
] as const;

export type TaskReasonCode = (typeof TASK_REASON_CODES)[number];

/** 标题长度上限（§4.5 的 `varchar(240)`）。 */
export const TASK_TITLE_MAX_LENGTH = 240;

/** 任务实体。 */
export interface Task {
  readonly id: string;
  readonly userId: string;
  readonly lifeAreaId: string | null;
  readonly goalId: string | null;
  readonly actionId: string | null;
  readonly title: string;
  readonly status: TaskStatus;
  readonly estimatedMinutes: number | null;
  readonly minimumVersion: string | null;
  /** 日历日（YYYY-MM-DD），日界的时区语义由展示层处理。 */
  readonly dueDate: string | null;
  readonly recurrenceRule: unknown;
  readonly source: 'manual' | 'ai' | 'import' | 'recurrence';
  readonly deletedAt: string | null;
  /**
   * 创建时刻（ISO）。不对外透出（DTO 层过滤），但重复任务的实例展开需要它：
   * `interval > 1` 的规则必须有一个稳定锚点日——模板的创建日即最自然的锚点
   * （DB §4.5 冻结口径：展开从锚点数起）。
   */
  readonly createdAt: string;
  readonly version: number;
}

/** 创建任务的输入（已通过校验）。 */
export interface TaskCreateInput {
  readonly title: string;
  readonly status: TaskStatus;
  readonly lifeAreaId: string | null;
  readonly dueDate: string | null;
  readonly estimatedMinutes: number | null;
  readonly minimumVersion: string | null;
  readonly goalId: string | null;
  readonly actionId: string | null;
}

/**
 * 更新任务的补丁：键存在即"要改这一项"。
 *
 * 状态**不在**补丁里——状态变更走专门的 `/status` 端点（它要写状态事件、
 * 校验流转、可携带原因码），与"改标题"是两种不同性质的操作。
 */
export interface TaskPatch {
  readonly title?: string | undefined;
  readonly lifeAreaId?: string | null | undefined;
  readonly dueDate?: string | null | undefined;
  readonly estimatedMinutes?: number | null | undefined;
  readonly minimumVersion?: string | null | undefined;
  readonly goalId?: string | null | undefined;
  readonly actionId?: string | null | undefined;
}

/** 一次状态流转的输入。 */
export interface TaskStatusChange {
  readonly to: TaskStatus;
  readonly reasonCode: TaskReasonCode | null;
  /** 一句话说明；属敏感内容，只随状态事件、不进日志原文。 */
  readonly note: string | null;
  readonly actualMinutes: number | null;
  readonly actualAmount: string | null;
}
