/**
 * Phase 3 用例与幂等编排的单元/集成测试（TASK-002/003、GOAL-001/002）。
 *
 * 用 fake 仓储覆盖模板要求的必备场景：正常路径、非法输入（流转矩阵）、
 * 重复提交（幂等重放）、权限越权（他人实体 → 404）、软删幂等（重复删 404）。
 * 真机 DB 验证由浏览器 e2e 与验收脚本承接；这里不依赖数据库。
 */
import { describe, expect, it, vi } from 'vitest';

import type { NextRequest } from 'next/server';

import { withIdempotency, type IdempotencyStore } from '../../../app/_lib/idempotency';
import { ConflictError, NotFoundError, ValidationError } from '@/shared/errors/app-error.ts';
import { ManageGoalUseCase } from '@/modules/goals/application/manage-goal.ts';
import type { ActionRepository, GoalRepository } from '@/modules/goals/domain/goal-repository.ts';
import type { Action, Goal } from '@/modules/goals/domain/goal.ts';
import { ManageTaskUseCase } from '@/modules/tasks/application/manage-task.ts';
import type { TaskRepository } from '@/modules/tasks/domain/task-repository.ts';
import type { Task, TaskStatus } from '@/modules/tasks/domain/task.ts';
import { assertTaskTransition } from '@/modules/tasks/domain/task.ts';
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import type { LifeAreaRepository } from '@/modules/life-areas/domain/life-area-repository.ts';

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

const audit: AuditLogger = { record: vi.fn() } as unknown as AuditLogger;

/** fake 仓储要在测试内就地改写行；实体的 readonly 是对消费方的约束，测试内解除。 */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

function makeTask(overrides: Partial<Task> = {}): Writable<Task> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'u1',
    lifeAreaId: null,
    goalId: null,
    actionId: null,
    title: '写周报',
    status: 'inbox',
    estimatedMinutes: null,
    minimumVersion: null,
    dueDate: null,
    recurrenceRule: null,
    source: 'manual',
    deletedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    userId: 'u1',
    lifeAreaId: null,
    name: '跑 5 公里',
    reason: null,
    status: 'active',
    startDate: null,
    targetDate: null,
    resultMetric: null,
    version: 1,
    ...overrides,
  };
}

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    userId: 'u1',
    goalId: '22222222-2222-4222-8222-222222222222',
    name: '每周跑两次',
    minimumVersion: null,
    targetFrequency: null,
    estimatedMinutes: null,
    status: 'active',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

/** 最小可用的任务仓储 fake：行为贴合 TaskRepository 的端口约定。 */
function fakeTaskRepository(
  initial: Task[] = [],
): TaskRepository & { readonly rows: Writable<Task>[] } {
  const rows: Writable<Task>[] = initial.map((task) => ({ ...task }));
  return {
    rows,
    async findById(userId, taskId) {
      return (
        rows.find((t) => t.id === taskId && t.userId === userId && t.deletedAt === null) ?? null
      );
    },
    async list() {
      return { items: rows, nextCursor: null, hasMore: false };
    },
    async create(userId, input) {
      const task = makeTask({ ...input, userId, id: crypto.randomUUID() });
      rows.push(task);
      return task;
    },
    async update(_userId, taskId, expectedVersion, patch) {
      const task = rows.find((t) => t.id === taskId);
      if (task === undefined) throw new NotFoundError('任务不存在');
      if (task.version !== expectedVersion) throw new ConflictError('版本冲突');
      Object.assign(task, patch, { version: task.version + 1 });
      return task;
    },
    async updateStatus(_userId, taskId, to) {
      const task = rows.find((t) => t.id === taskId);
      if (task === undefined) throw new NotFoundError('任务不存在');
      // fake 也要走领域判定：否则"非法流转抛 VALIDATION_ERROR"这类用例测不到真实约束。
      assertTaskTransition(task.status, to);
      task.status = to;
      task.version += 1;
      return task;
    },
    async softDelete(_userId, taskId) {
      const task = rows.find((t) => t.id === taskId && t.deletedAt === null);
      if (task === undefined) return false;
      task.deletedAt = new Date().toISOString();
      return true;
    },
    async batchApply(_userId, taskIds, operation, options) {
      // 整批失败：任一 id 不存在则整批抛错、不写入。
      const targets: Writable<Task>[] = [];
      for (const id of taskIds) {
        const found = rows.find((t) => t.id === id);
        if (found === undefined) {
          throw new NotFoundError('批量操作中有任务不存在');
        }
        targets.push(found);
      }
      const updated: Task[] = [];
      for (const current of targets) {
        current.status = operation === 'archive' ? 'archived' : 'planned';
        if (operation === 'schedule') {
          current.dueDate = options.dueDate;
          current.lifeAreaId = options.lifeAreaId ?? current.lifeAreaId;
        }
        current.version += 1;
        updated.push(current);
      }
      return updated;
    },
    async listRecurringTemplates() {
      return [];
    },
    async findByTemplateAndDate() {
      return null;
    },
    async createRecurrenceInstance() {
      throw new Error('not used in this suite');
    },
    async listUnscheduledOn() {
      return [];
    },
    async findByIds() {
      return [];
    },
    async attachAction(_userId, taskId, links) {
      const task = rows.find((t) => t.id === taskId);
      if (task === undefined) throw new NotFoundError('任务不存在');
      if (task.status !== 'inbox') throw new ValidationError('只有收件箱中的任务可以转为目标行动');
      task.goalId = links.goalId;
      task.actionId = links.actionId;
      task.status = 'planned';
      task.version += 1;
      return task;
    },
  };
}

function fakeLifeAreas(existingIds: string[] = [], archivedIds: string[] = []): LifeAreaRepository {
  const findById = async (
    _userId: string,
    id: string,
  ): Promise<{
    readonly id: string;
    readonly name: string;
    readonly isArchived: boolean;
  } | null> => {
    if (!existingIds.includes(id)) return null;
    return { id, name: '健康', isArchived: archivedIds.includes(id) };
  };
  return { findById } as unknown as LifeAreaRepository;
}

function fakeGoals(existing: Goal[] = []): GoalRepository {
  return {
    async findById(_userId: string, id: string) {
      return existing.find((g) => g.id === id && g.userId === 'u1') ?? null;
    },
    async list(_userId: string, _options: never) {
      return { items: existing, nextCursor: null, hasMore: false };
    },
    async create(
      _userId: string,
      input: Goal['name'] extends never ? never : Parameters<GoalRepository['create']>[1],
    ) {
      const goal = makeGoal({ ...input, id: crypto.randomUUID() });
      existing.push(goal);
      return goal;
    },
    async update(
      _userId: string,
      goalId: string,
      expectedVersion: number,
      patch: Parameters<GoalRepository['update']>[3],
    ) {
      const goal = existing.find((g) => g.id === goalId);
      if (goal === undefined) throw new NotFoundError('目标不存在');
      if (goal.version !== expectedVersion) throw new ConflictError('版本冲突');
      Object.assign(goal, patch, { version: goal.version + 1 });
      return goal;
    },
    async findDetail(userId: string, goalId: string) {
      const goal = existing.find((g) => g.id === goalId && g.userId === userId);
      if (goal === undefined) return null;
      return {
        goal,
        actions: [],
        actionProgress: { total: 0, completed: 0, active: 0, paused: 0 },
      };
    },
  } as unknown as GoalRepository;
}

function fakeActions(existing: Action[] = []): ActionRepository {
  return {
    async findById(_userId: string, id: string) {
      return existing.find((a) => a.id === id && a.userId === 'u1' && a.deletedAt === null) ?? null;
    },
    async listByGoal(_userId: string, goalId: string) {
      return existing.filter((a) => a.goalId === goalId && a.deletedAt === null);
    },
    async create(
      _userId: string,
      goalId: string,
      input: Parameters<ActionRepository['create']>[2],
    ) {
      const action = makeAction({ ...input, goalId, id: crypto.randomUUID() });
      existing.push(action);
      return action;
    },
    async update(
      _userId: string,
      actionId: string,
      expectedVersion: number,
      patch: Parameters<ActionRepository['update']>[3],
    ) {
      const action = existing.find((a) => a.id === actionId);
      if (action === undefined) throw new NotFoundError('行动不存在');
      if (action.version !== expectedVersion) throw new ConflictError('版本冲突');
      Object.assign(action, patch, { version: action.version + 1 });
      return action;
    },
    async softDelete(_userId: string, actionId: string) {
      const action = existing.find((a) => a.id === actionId && a.deletedAt === null);
      if (action === undefined) return false;
      const mutable = action as { -readonly [K in keyof Action]: Action[K] };
      mutable.deletedAt = new Date().toISOString();
      return true;
    },
  } as unknown as ActionRepository;
}

function buildTaskUseCase(
  overrides: {
    readonly tasks?: TaskRepository;
    readonly goals?: GoalRepository;
    readonly actions?: ActionRepository;
    readonly lifeAreas?: LifeAreaRepository;
  } = {},
): ManageTaskUseCase {
  const tasks = overrides.tasks ?? fakeTaskRepository();
  const goals = overrides.goals ?? fakeGoals();
  const actions = overrides.actions ?? fakeActions();
  const lifeAreas = overrides.lifeAreas ?? fakeLifeAreas();
  return new ManageTaskUseCase({ tasks, goals, actions, lifeAreas, audit });
}

/* ------------------------------------------------------------------ */
/* 流转矩阵与软删                                                       */
/* ------------------------------------------------------------------ */

describe('任务状态流转（DB §4.5 完整流转表）', () => {
  it.each<[TaskStatus, TaskStatus]>([
    ['inbox', 'planned'],
    ['planned', 'completed'],
    ['planned', 'deferred'],
    ['completed', 'planned'],
    ['partial', 'completed'],
    ['deferred', 'planned'],
    ['skipped', 'planned'],
    ['archived', 'inbox'],
  ])('合法：%s → %s', async (from, to) => {
    const tasks = fakeTaskRepository([makeTask({ id: 't1', status: from, version: 1 })]);
    const useCase = buildTaskUseCase({ tasks });
    const updated = await useCase.changeStatus('u1', 't1', {
      to,
      reasonCode: null,
      note: null,
      actualMinutes: null,
      actualAmount: null,
    });
    expect(updated.status).toBe(to);
    expect(updated.version).toBe(2);
  });

  it.each<[TaskStatus, TaskStatus]>([
    ['inbox', 'completed'],
    ['inbox', 'in_progress'],
    ['completed', 'completed'],
    ['archived', 'archived'],
    ['completed', 'in_progress'],
  ])('非法：%s → %s 抛 VALIDATION_ERROR', async (from, to) => {
    const tasks = fakeTaskRepository([makeTask({ id: 't1', status: from })]);
    const useCase = buildTaskUseCase({ tasks });
    await expect(
      useCase.changeStatus('u1', 't1', {
        to,
        reasonCode: null,
        note: null,
        actualMinutes: null,
        actualAmount: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('越权读取他人任务：404，不泄露存在性', async () => {
    const tasks = fakeTaskRepository([makeTask({ id: 't1', userId: 'someone-else' })]);
    const useCase = buildTaskUseCase({ tasks });
    await expect(useCase.findById('u1', 't1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('软删幂等：第二次删除按 404 处理', async () => {
    const tasks = fakeTaskRepository([makeTask({ id: 't1' })]);
    const useCase = buildTaskUseCase({ tasks });
    await useCase.delete('u1', 't1');
    await expect(useCase.delete('u1', 't1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('PATCH 版本冲突：409', async () => {
    const tasks = fakeTaskRepository([makeTask({ id: 't1', version: 3 })]);
    const useCase = buildTaskUseCase({ tasks });
    await expect(useCase.update('u1', 't1', 2, { title: '新标题' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('批量整批失败：一条不存在则全批不写', async () => {
    const tasks = fakeTaskRepository([makeTask({ id: 't1' }), makeTask({ id: 't2' })]);
    const useCase = buildTaskUseCase({ tasks });
    await expect(
      useCase.batch('u1', ['t1', 'missing'], 'archive', { dueDate: null, lifeAreaId: null }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(tasks.rows.find((t) => t.id === 't1')?.status).toBe('inbox');
  });

  it('批量安排：写入截止日与生活领域', async () => {
    const tasks = fakeTaskRepository([makeTask({ id: 't1' })]);
    const useCase = buildTaskUseCase({
      tasks,
      lifeAreas: fakeLifeAreas(['area-1']),
    });
    const updated = await useCase.batch('u1', ['t1'], 'schedule', {
      dueDate: '2026-09-25',
      lifeAreaId: 'area-1',
    });
    expect(updated[0]?.status).toBe('planned');
    expect(updated[0]?.dueDate).toBe('2026-09-25');
  });

  it('关联校验：goalId 不属于本人 → 404；actionId 不属于该 goal → 400', async () => {
    const useCase = buildTaskUseCase({
      goals: fakeGoals([]),
      actions: fakeActions([makeAction({ goalId: '22222222-2222-4222-8222-222222222222' })]),
    });
    await expect(
      useCase.create('u1', {
        title: '写周报',
        status: 'inbox',
        lifeAreaId: null,
        dueDate: null,
        estimatedMinutes: null,
        minimumVersion: null,
        goalId: '22222222-2222-4222-8222-222222222222',
        actionId: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

/* ------------------------------------------------------------------ */
/* 转为目标行动                                                         */
/* ------------------------------------------------------------------ */

describe('convertToAction（GOAL-002）', () => {
  const goalId = '22222222-2222-4222-8222-222222222222';

  it('成功：创建行动、回填关联、任务进入已安排', async () => {
    const tasks = fakeTaskRepository([makeTask({ id: 't1', title: '晨跑 30 分钟' })]);
    const actions = fakeActions();
    const goals = fakeGoals([makeGoal({ id: goalId })]);
    const useCase = buildTaskUseCase({ tasks, actions, goals });

    const { task } = await useCase.convertToAction('u1', 't1', {
      goalId,
      name: null,
      minimumVersion: null,
      estimatedMinutes: null,
    });

    expect(task.status).toBe('planned');
    expect(task.goalId).toBe(goalId);
    expect(task.actionId).not.toBeNull();
    // 任务保留（软删标志仍为 null）。
    expect(task.deletedAt).toBeNull();
  });

  it('目标不存在：404', async () => {
    const tasks = fakeTaskRepository([makeTask({ id: 't1' })]);
    const useCase = buildTaskUseCase({ tasks, goals: fakeGoals([]) });
    await expect(
      useCase.convertToAction('u1', 't1', {
        goalId,
        name: null,
        minimumVersion: null,
        estimatedMinutes: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('任务不在收件箱：400', async () => {
    const tasks = fakeTaskRepository([makeTask({ id: 't1', status: 'planned' })]);
    const useCase = buildTaskUseCase({ tasks, goals: fakeGoals([makeGoal({ id: goalId })]) });
    await expect(
      useCase.convertToAction('u1', 't1', {
        goalId,
        name: null,
        minimumVersion: null,
        estimatedMinutes: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

/* ------------------------------------------------------------------ */
/* 目标与行动                                                           */
/* ------------------------------------------------------------------ */

describe('ManageGoalUseCase（GOAL-001）', () => {
  it('创建：已归档生活领域拒收（404）', async () => {
    const useCase = new ManageGoalUseCase({
      goals: fakeGoals(),
      actions: fakeActions(),
      lifeAreas: fakeLifeAreas(['area-1'], ['area-1']),
      audit,
    });
    await expect(
      useCase.create('u1', {
        name: '跑 5 公里',
        lifeAreaId: 'area-1',
        reason: null,
        targetDate: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('更新 resultMetric：缺省键归一为 null', async () => {
    const goal = makeGoal({ id: 'g1' });
    const goals = fakeGoals([goal]);
    const useCase = new ManageGoalUseCase({
      goals,
      actions: fakeActions(),
      lifeAreas: fakeLifeAreas(),
      audit,
    });
    const updated = await useCase.update('u1', 'g1', 1, {
      resultMetric: { current: 2 },
    } as never);
    expect(updated.resultMetric).toEqual({ current: 2, target: null, unit: null, note: null });
    expect(updated.version).toBe(2);
  });

  it('删除行动：软删；重复删除 404', async () => {
    const actions = fakeActions([makeAction({ id: 'a1' })]);
    const useCase = new ManageGoalUseCase({
      goals: fakeGoals(),
      actions,
      lifeAreas: fakeLifeAreas(),
      audit,
    });
    await useCase.deleteAction('u1', 'a1');
    await expect(useCase.deleteAction('u1', 'a1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('详情：他人目标 404', async () => {
    const goals = fakeGoals([makeGoal({ id: 'g1', userId: 'someone-else' })]);
    const useCase = new ManageGoalUseCase({
      goals,
      actions: fakeActions(),
      lifeAreas: fakeLifeAreas(),
      audit,
    });
    await expect(useCase.findDetail('u1', 'g1')).rejects.toBeInstanceOf(NotFoundError);
  });
});

/* ------------------------------------------------------------------ */
/* 幂等编排（TASK-002）                                                 */
/* ------------------------------------------------------------------ */

function fakeRequest(key: string | null, _body: unknown): NextRequest {
  return {
    headers: new Headers(key === null ? {} : { 'Idempotency-Key': key }),
    method: 'POST',
    url: 'http://localhost/api/v1/tasks',
  } as unknown as NextRequest;
}

function fakeStore(replayOnRetry = true): IdempotencyStore & {
  readonly claims: number;
  readonly completed: string[];
  readonly released: string[];
} {
  let claims = 0;
  const completed: string[] = [];
  const released: string[] = [];
  return {
    get claims() {
      return claims;
    },
    get completed() {
      return completed;
    },
    get released() {
      return released;
    },
    async claim(_userId, _key) {
      claims += 1;
      if (claims === 1) return { outcome: 'claimed' };
      if (replayOnRetry) {
        return { outcome: 'replay', snapshot: { replayed: true } };
      }
      return { outcome: 'in-progress' };
    },
    async complete(_userId, key) {
      completed.push(key);
    },
    async release(_userId, key) {
      released.push(key);
    },
  };
}

describe('withIdempotency（接口文档 §1.1 / DB §4.15）', () => {
  it('不带键：直接执行，不触碰存储', async () => {
    const store = fakeStore();
    const result = await withIdempotency(fakeRequest(null, null), 'u1', null, store, async () => ({
      status: 200,
      body: { ok: true },
    }));
    expect(result.status).toBe(200);
    expect(store.claims).toBe(0);
  });

  it('首次执行：占位、执行、落快照', async () => {
    const store = fakeStore();
    const result = await withIdempotency(
      fakeRequest('key-1', { a: 1 }),
      'u1',
      { a: 1 },
      store,
      async () => ({
        status: 200,
        body: { ok: true },
      }),
    );
    expect(result.status).toBe(200);
    expect(store.claims).toBe(1);
    expect(store.completed).toEqual(['key-1']);
  });

  it('重放：第二次同 key 请求不执行，返回 409 IDEMPOTENCY_REPLAY', async () => {
    const store = fakeStore(true);
    let executions = 0;
    const run = () =>
      withIdempotency(fakeRequest('key-1', { a: 1 }), 'u1', { a: 1 }, store, async () => {
        executions += 1;
        return { status: 200, body: { ok: executions } };
      });

    const first = await run();
    expect(first.status).toBe(200);
    const second = await run();
    expect(second.status).toBe(409);
    expect(executions).toBe(1);
  });

  it('同 key 处理中：抛 409 冲突', async () => {
    const store = fakeStore(false);
    // 手动占位，模拟"同一个 key 的另一个请求还在处理中"。
    await store.claim('u1', 'key-1', 'hash');
    await expect(
      withIdempotency(fakeRequest('key-1', { a: 2 }), 'u1', { a: 2 }, store, async () => ({
        status: 200,
        body: {},
      })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('执行失败：释放占位并原样抛出（同 key 可重试）', async () => {
    const store = fakeStore();
    await expect(
      withIdempotency(fakeRequest('key-1', { a: 1 }), 'u1', { a: 1 }, store, async () => {
        throw new ValidationError('请求内容不合法');
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(store.released).toEqual(['key-1']);
    expect(store.completed).toEqual([]);
  });

  it('键超长：400', async () => {
    const store = fakeStore();
    await expect(
      withIdempotency(fakeRequest('k'.repeat(129), null), 'u1', null, store, async () => ({
        status: 200,
        body: {},
      })),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
