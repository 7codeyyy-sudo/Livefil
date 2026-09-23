/**
 * 目标与行动仓储端口（GOAL-001/002）。
 *
 * 端口放 `domain/` 的理由与 `tasks/domain/task-repository.ts` 相同：
 * `modules/<模块>/infrastructure` 被禁止引用 `application`，实现方只能依赖
 * 领域层给出的抽象。
 */
import type {
  Action,
  ActionCreateInput,
  ActionPatch,
  ActionProgress,
  Goal,
  GoalCreateInput,
  GoalPatch,
  GoalStatus,
} from './goal.ts';

export interface ListGoalsOptions {
  readonly status?: GoalStatus | undefined;
  readonly lifeAreaId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface GoalPage {
  readonly items: readonly Goal[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** 目标详情：目标本体 + 行动 + 由行动汇总的进度（关联开销 Phase 6 前恒为空集合）。 */
export interface GoalDetail {
  readonly goal: Goal;
  readonly actions: readonly Action[];
  readonly actionProgress: ActionProgress;
}

export interface GoalRepository {
  findById(userId: string, goalId: string): Promise<Goal | null>;

  list(userId: string, options: ListGoalsOptions): Promise<GoalPage>;

  create(userId: string, input: GoalCreateInput): Promise<Goal>;

  /** 乐观并发更新；`expectedVersion` 不匹配抛 `ConflictError`，找不到行抛 `NotFoundError`。 */
  update(userId: string, goalId: string, expectedVersion: number, patch: GoalPatch): Promise<Goal>;

  /**
   * 详情聚合：目标 + 未删除行动 + 行动进度。一次查而不是三次往返——
   * 详情页每次打开都要这三样，拆开只会多两次数据库往返。
   */
  findDetail(userId: string, goalId: string): Promise<GoalDetail | null>;
}

export interface ActionRepository {
  findById(userId: string, actionId: string): Promise<Action | null>;

  /** 列出某目标下**未删除**的行动（创建时间升序——行动是按推进顺序长出来的）。 */
  listByGoal(userId: string, goalId: string): Promise<readonly Action[]>;

  create(userId: string, goalId: string, input: ActionCreateInput): Promise<Action>;

  update(
    userId: string,
    actionId: string,
    expectedVersion: number,
    patch: ActionPatch,
  ): Promise<Action>;

  /**
   * 软删行动，并在**同一事务**把关联任务的 `action_id` 置空（`goal_id` 保留、
   * 任务不删）——否则任务会指向一个已删除的行动，详情无法解析。
   */
  softDelete(userId: string, actionId: string): Promise<boolean>;

  /**
   * 习惯（FR-030，2026-09-21 冻结口径）：active 目标下带 `target_frequency`
   * 的行动——无独立 habits 表。/today 的 `doneToday` 由执行记录另行判定。
   */
  listHabitActions(userId: string): Promise<readonly Action[]>;
}

/** 由行动状态汇总出行动进度（纯函数，供用例与详情聚合复用）。 */
export function summarizeActionProgress(actions: readonly Action[]): ActionProgress {
  const progress = { total: 0, completed: 0, active: 0, paused: 0 };
  for (const action of actions) {
    if (action.deletedAt !== null) {
      continue;
    }
    progress.total += 1;
    if (action.status === 'completed') {
      progress.completed += 1;
    } else if (action.status === 'paused') {
      progress.paused += 1;
    } else {
      progress.active += 1;
    }
  }
  return progress;
}
