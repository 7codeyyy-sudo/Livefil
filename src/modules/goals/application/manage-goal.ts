/**
 * 目标与行动管理用例（GOAL-001/002，《详细设计说明书》§3.2、接口文档 §5）。
 *
 * 与 `ManageTaskUseCase` 同构：一个用例类收拢目标与行动两个聚合的写操作。
 * 行动进度永远由行动状态**汇总**得出，服务端不据 `resultMetric` 判定目标完成
 * （SRS FR-023 的既定口径）。
 */
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { NotFoundError } from '@/shared/errors/app-error.ts';

import {
  assertResultMetric,
  type Action,
  type ActionCreateInput,
  type ActionPatch,
  type Goal,
  type GoalCreateInput,
  type GoalPatch,
} from '../domain/goal.ts';
import {
  summarizeActionProgress,
  type ActionRepository,
  type GoalDetail,
  type GoalRepository,
  type ListGoalsOptions,
  type GoalPage,
} from '../domain/goal-repository.ts';
import type { LifeAreaRepository } from '../../life-areas/domain/life-area-repository.ts';

export interface ManageGoalDependencies {
  readonly goals: GoalRepository;
  readonly actions: ActionRepository;
  readonly lifeAreas: LifeAreaRepository;
  readonly audit: AuditLogger;
}

export class ManageGoalUseCase {
  readonly #goals: GoalRepository;
  readonly #actions: ActionRepository;
  readonly #lifeAreas: LifeAreaRepository;
  readonly #audit: AuditLogger;

  constructor(dependencies: ManageGoalDependencies) {
    this.#goals = dependencies.goals;
    this.#actions = dependencies.actions;
    this.#lifeAreas = dependencies.lifeAreas;
    this.#audit = dependencies.audit;
  }

  list(userId: string, options: ListGoalsOptions): Promise<GoalPage> {
    return this.#goals.list(userId, options);
  }

  /** 单条读取：不存在 / 非本人一律抛 404。 */
  async findById(userId: string, goalId: string): Promise<Goal> {
    const goal = await this.#goals.findById(userId, goalId);
    if (goal === null) {
      throw new NotFoundError('目标不存在');
    }
    return goal;
  }

  /** 详情聚合（目标 + 行动 + 行动进度）。 */
  async findDetail(userId: string, goalId: string): Promise<GoalDetail> {
    const detail = await this.#goals.findDetail(userId, goalId);
    if (detail === null) {
      throw new NotFoundError('目标不存在');
    }
    return detail;
  }

  async create(userId: string, input: GoalCreateInput, requestId?: string): Promise<Goal> {
    await this.#assertLifeArea(userId, input.lifeAreaId);

    const created = await this.#goals.create(userId, input);
    this.#record('DATA_CREATED', userId, requestId);
    return created;
  }

  /**
   * 更新目标（名称 / 理由 / 目标日期 / 状态 / resultMetric）。
   *
   * `resultMetric` 在进补丁前过 `assertResultMetric` 归一空值——校验收口在
   * 领域函数上，schema 与仓储实现都不重复这套规则。
   */
  async update(
    userId: string,
    goalId: string,
    expectedVersion: number,
    patch: GoalPatch,
    requestId?: string,
  ): Promise<Goal> {
    let normalized: GoalPatch = { ...patch };
    if (patch.resultMetric !== undefined && patch.resultMetric !== null) {
      // 校验并归一空值（缺省键补 null）——收口在领域函数上，schema 与仓储不重复这套规则。
      normalized = { ...patch, resultMetric: assertResultMetric(patch.resultMetric) };
    }

    const updated = await this.#goals.update(userId, goalId, expectedVersion, normalized);
    this.#record('DATA_UPDATED', userId, requestId);
    return updated;
  }

  /** 在目标下创建行动。 */
  async createAction(
    userId: string,
    goalId: string,
    input: ActionCreateInput,
    requestId?: string,
  ): Promise<Action> {
    const goal = await this.#goals.findById(userId, goalId);
    if (goal === null) {
      throw new NotFoundError('目标不存在');
    }

    const created = await this.#actions.create(userId, goalId, input);
    this.#record('DATA_CREATED', userId, requestId);
    return created;
  }

  async updateAction(
    userId: string,
    actionId: string,
    expectedVersion: number,
    patch: ActionPatch,
    requestId?: string,
  ): Promise<Action> {
    const updated = await this.#actions.update(userId, actionId, expectedVersion, patch);
    this.#record('DATA_UPDATED', userId, requestId);
    return updated;
  }

  /**
   * 删除行动（软删 + 同事务解链任务关联，任务不删）。
   * 重复删除与不存在同义：404。
   */
  async deleteAction(userId: string, actionId: string, requestId?: string): Promise<void> {
    const deleted = await this.#actions.softDelete(userId, actionId);
    if (!deleted) {
      throw new NotFoundError('行动不存在');
    }
    this.#record('DATA_DELETED', userId, requestId);
  }

  async #assertLifeArea(userId: string, lifeAreaId: string | null | undefined): Promise<void> {
    if (lifeAreaId == null) {
      return;
    }
    // 已归档领域不出现在选择器，也不接受被新目标引用——对调用方与"不存在"同义。
    const area = await this.#lifeAreas.findById(userId, lifeAreaId);
    if (area === null || area.isArchived) {
      throw new NotFoundError('生活领域不存在');
    }
  }

  #record(type: Parameters<AuditLogger['record']>[0]['type'], userId: string, requestId?: string) {
    this.#audit.record({
      type,
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
}

/** 行动进度汇总的单一出口（详情页与用例共用同一份口径）。 */
export { summarizeActionProgress };
