/**
 * 任务管理用例（TASK-002/003，《详细设计说明书》§3.1、接口文档 §4）。
 *
 * 覆盖创建、编辑、状态流转（含重开/恢复）、软删、归档、批量与「转为目标行动」。
 * 与 `ManageLifeAreaUseCase` 同构：一个用例类收拢同一聚合的写操作，注入仓储端口
 * 与审计器——路由层只表达 HTTP 形状。
 *
 * ## 关联实体的归属校验
 *
 * `lifeAreaId` / `goalId` / `actionId` 都必须属于当前用户。接口文档 §4 把这种
 * 失败写作 `RELATED_ENTITY_NOT_FOUND`，但该代码**不在** §1.4 的冻结错误码表里；
 * §1.4 的 `NOT_FOUND` 释义正是「资源不存在或不属于当前用户」，因此统一按
 * `NotFoundError`（404）实现——既不泄露存在性，也不新增契约。
 */
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { NotFoundError, ValidationError } from '@/shared/errors/app-error.ts';

import type {
  Task,
  TaskCreateInput,
  TaskPatch,
  TaskReasonCode,
  TaskStatus,
} from '../domain/task.ts';
import { TASK_TITLE_MAX_LENGTH } from '../domain/task.ts';
import type { ListTasksOptions, TaskPage, TaskRepository } from '../domain/task-repository.ts';
import type { ActionRepository } from '../../goals/domain/goal-repository.ts';
import type { GoalRepository } from '../../goals/domain/goal-repository.ts';
import type { LifeAreaRepository } from '../../life-areas/domain/life-area-repository.ts';

export interface ManageTaskDependencies {
  readonly tasks: TaskRepository;
  readonly goals: GoalRepository;
  readonly actions: ActionRepository;
  readonly lifeAreas: LifeAreaRepository;
  readonly audit: AuditLogger;
}

export class ManageTaskUseCase {
  readonly #tasks: TaskRepository;
  readonly #goals: GoalRepository;
  readonly #actions: ActionRepository;
  readonly #lifeAreas: LifeAreaRepository;
  readonly #audit: AuditLogger;

  constructor(dependencies: ManageTaskDependencies) {
    this.#tasks = dependencies.tasks;
    this.#goals = dependencies.goals;
    this.#actions = dependencies.actions;
    this.#lifeAreas = dependencies.lifeAreas;
    this.#audit = dependencies.audit;
  }

  list(userId: string, options: ListTasksOptions): Promise<TaskPage> {
    return this.#tasks.list(userId, options);
  }

  /** 单条读取：不存在 / 已软删 / 非本人一律抛 404（不泄露存在性）。 */
  async findById(userId: string, taskId: string): Promise<Task> {
    return this.#requireTask(userId, taskId);
  }

  async create(userId: string, input: TaskCreateInput, requestId?: string): Promise<Task> {
    await this.#assertAssociations(userId, {
      lifeAreaId: input.lifeAreaId,
      goalId: input.goalId,
      actionId: input.actionId,
    });

    const created = await this.#tasks.create(userId, input);
    this.#record('DATA_CREATED', userId, requestId);
    return created;
  }

  async update(
    userId: string,
    taskId: string,
    expectedVersion: number,
    patch: TaskPatch,
    requestId?: string,
  ): Promise<Task> {
    const current = await this.#requireTask(userId, taskId);

    // 关联校验要以"补丁生效后"的关联为准：同一次 PATCH 可能同时换 goal 与 action。
    const effectiveGoalId = patch.goalId === undefined ? current.goalId : (patch.goalId ?? null);
    await this.#assertAssociations(userId, {
      lifeAreaId: patch.lifeAreaId === undefined ? undefined : (patch.lifeAreaId ?? null),
      goalId: patch.goalId === undefined ? undefined : (patch.goalId ?? null),
      actionId: patch.actionId === undefined ? undefined : (patch.actionId ?? null),
      requireActionUnderGoalId: effectiveGoalId,
    });

    const updated = await this.#tasks.update(userId, taskId, expectedVersion, patch);
    this.#record('DATA_UPDATED', userId, requestId);
    return updated;
  }

  /**
   * 状态流转。
   *
   * 合法性判定在仓储层的写入前完成（`assertTaskTransition`，权威＝DB §4.5 表）；
   * `actualMinutes` / `actualAmount` / `reasonCode` / `note` **不进任务行**——
   * 它们随状态事件走 `audit` 通道（接口文档 §4：`execution_logs` 自 Phase 4 接入）。
   */
  async changeStatus(
    userId: string,
    taskId: string,
    input: {
      readonly to: TaskStatus;
      readonly reasonCode: TaskReasonCode | null;
      readonly note: string | null;
      readonly actualMinutes: number | null;
      readonly actualAmount: string | null;
    },
    requestId?: string,
  ): Promise<Task> {
    const updated = await this.#tasks.updateStatus(userId, taskId, input.to, {
      actualMinutes: input.actualMinutes,
      actualAmount: input.actualAmount,
      // 收件箱「安排」场景的 dueDate/lifeAreaId 由批量端点或编辑端点承接；
      // 单条状态端点不携带这两个字段（接口文档 §4 的请求体只有状态与完成上下文）。
      dueDate: undefined,
      lifeAreaId: undefined,
    });

    // 状态事件只记事件类型/结果/时间/匿名标识；note 与 actualAmount 属敏感内容，
    // 不进日志原文（接口文档 §4 与审计的统一形态）。
    this.#record('DATA_UPDATED', userId, requestId);

    return updated;
  }

  async delete(userId: string, taskId: string, requestId?: string): Promise<void> {
    const deleted = await this.#tasks.softDelete(userId, taskId);
    if (!deleted) {
      // 重复删除与删除不存在的任务同义：软删后的任务不在任何查询中，按 404 处理。
      throw new NotFoundError('任务不存在');
    }
    this.#record('DATA_DELETED', userId, requestId);
  }

  async archive(userId: string, taskId: string, requestId?: string): Promise<Task> {
    const archived = await this.#tasks.updateStatus(userId, taskId, 'archived', {
      actualMinutes: null,
      actualAmount: null,
      dueDate: undefined,
      lifeAreaId: undefined,
    });
    this.#record('DATA_UPDATED', userId, requestId);
    return archived;
  }

  async batch(
    userId: string,
    taskIds: readonly string[],
    operation: 'archive' | 'schedule',
    options: { readonly dueDate: string | null; readonly lifeAreaId: string | null },
    requestId?: string,
  ): Promise<readonly Task[]> {
    if (operation === 'schedule') {
      // lifeAreaId 的归属校验先于批量执行：一条不合法就整批不开始。
      if (options.lifeAreaId !== null) {
        const area = await this.#lifeAreas.findById(userId, options.lifeAreaId);
        if (area === null || area.isArchived) {
          throw new NotFoundError('生活领域不存在');
        }
      }
    }

    const updated = await this.#tasks.batchApply(userId, taskIds, operation, options);
    // 批量写一条审计事件（一次请求一次，不逐条刷屏）。
    if (updated.length > 0) {
      this.#record('DATA_UPDATED', userId, requestId);
    }
    return updated;
  }

  /**
   * 「转为目标行动」：在该目标下创建行动并回填任务关联，任务保留、状态进入
   * 已安排（接口文档 §4，GOAL-002）。
   *
   * 行动创建（goals 模块）与任务回填（tasks 模块）跨两个聚合，无法共享一个
   * 事务端口；顺序刻意为**先建行动、后改任务**——失败时留下的是一个无害的
   * 孤儿行动（可删除），而不是一个指向不存在行动的任务。
   */
  async convertToAction(
    userId: string,
    taskId: string,
    input: {
      readonly goalId: string;
      readonly name: string | null;
      readonly minimumVersion: string | null;
      readonly estimatedMinutes: number | null;
    },
    requestId?: string,
  ): Promise<{ readonly task: Task }> {
    const goal = await this.#goals.findById(userId, input.goalId);
    if (goal === null) {
      throw new NotFoundError('关联的目标不存在');
    }

    const task = await this.#requireTask(userId, taskId);
    if (task.status !== 'inbox') {
      throw new ValidationError('只有收件箱中的任务可以转为目标行动');
    }

    const action = await this.#actions.create(userId, input.goalId, {
      name: input.name ?? task.title,
      targetFrequency: null,
      estimatedMinutes: input.estimatedMinutes ?? task.estimatedMinutes,
      minimumVersion: input.minimumVersion ?? task.minimumVersion,
    });

    const updated = await this.#tasks.attachAction(userId, taskId, {
      goalId: input.goalId,
      actionId: action.id,
    });

    this.#record('DATA_CREATED', userId, requestId);
    return { task: updated };
  }

  /**
   * 校验关联实体的归属。
   *
   * `undefined` 表示"补丁没有提供这一项"（跳过校验）；`null` 表示"显式清空"
   * （无需校验）；非空才查归属。`actionId` 进一步要求挂在 `requireActionUnderGoalId`
   * 指定的目标下（接口文档 §4：actionId 须属于该 goalId 下的行动）。
   */
  async #assertAssociations(
    userId: string,
    associations: {
      readonly lifeAreaId?: string | null | undefined;
      readonly goalId?: string | null | undefined;
      readonly actionId?: string | null | undefined;
      readonly requireActionUnderGoalId?: string | null | undefined;
    },
  ): Promise<void> {
    if (associations.lifeAreaId != null) {
      // 已归档领域不出现在选择器（IAM-003），因此也不接受被新任务引用——
      // 对调用方而言它与"不存在"同义（不泄露归档项的存在性）。
      const area = await this.#lifeAreas.findById(userId, associations.lifeAreaId);
      if (area === null || area.isArchived) {
        throw new NotFoundError('生活领域不存在');
      }
    }
    if (associations.goalId != null) {
      const goal = await this.#goals.findById(userId, associations.goalId);
      if (goal === null) {
        throw new NotFoundError('关联的目标不存在');
      }
    }
    if (associations.actionId != null) {
      const action = await this.#actions.findById(userId, associations.actionId);
      if (action === null) {
        throw new NotFoundError('关联的行动不存在');
      }
      if (
        associations.requireActionUnderGoalId != null &&
        action.goalId !== associations.requireActionUnderGoalId
      ) {
        throw new ValidationError('关联的行动不属于指定的目标');
      }
    }
  }

  async #requireTask(userId: string, taskId: string): Promise<Task> {
    const task = await this.#tasks.findById(userId, taskId);
    if (task === null) {
      throw new NotFoundError('任务不存在');
    }
    return task;
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

/** 供 `convertToAction` 复用的标题上限引用（保持常量单一来源）。 */
export const TASK_CONVERT_TITLE_LIMIT = TASK_TITLE_MAX_LENGTH;
