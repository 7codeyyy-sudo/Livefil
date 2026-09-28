/**
 * 开销管理用例（EXP-002/003/004，《接口文档》§9）。
 *
 * 与 `ManageTaskUseCase` 同构：一个用例类收拢同一聚合的读写，注入仓储端口与审计器，
 * 路由层只表达 HTTP 形状。
 *
 * ## 关联实体的归属校验
 *
 * `categoryId` / `lifeAreaId` / `goalId` / `actionId` 都必须属于当前用户。
 * `expenses` 与 `tasks` 的差异只有两处，且都是**冻结口径**要求的：
 *
 * - **归档目标可关联**：PD-20260928-007 拍板 4③「归档目标的开销照进目标关联汇总，
 *   历史事实不因归档消失，选择器中归档目标降级显示」——因此这里不像任务那样
 *   把归档目标当"不存在"。
 * - **停用分类不可新选**：A3「已停用分类不出现在新建/切换列表……编辑分类已停用的
 *   开销时原分类作为当前值显示，只可保持或换新」——保持原样放行，换新则拒绝。
 */
import { NotFoundError, ValidationError } from '@/shared/errors/app-error.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import type { AuditEventType, AuditLogger } from '@/shared/telemetry/audit-event.ts';

import type { Expense, ExpenseCreateInput, ExpensePatch } from '../domain/expense.ts';
import type { ExpenseCategoryRepository } from '../domain/expense-category-repository.ts';
import type {
  ExpensePage,
  ExpenseRepository,
  ExpenseSummary,
  ExpenseSummaryOptions,
  ListExpensesOptions,
} from '../domain/expense-repository.ts';
import type { ActionRepository, GoalRepository } from '../../goals/domain/goal-repository.ts';
import type { LifeAreaRepository } from '../../life-areas/domain/life-area-repository.ts';

/** 补丁可能改动的关联字段（`undefined`＝不改，`null`＝清空）。 */
interface AssociationPatch {
  readonly categoryId?: string | undefined;
  readonly lifeAreaId?: string | null | undefined;
  readonly goalId?: string | null | undefined;
  readonly actionId?: string | null | undefined;
}

export interface ManageExpenseDependencies {
  readonly expenses: ExpenseRepository;
  readonly expenseCategories: ExpenseCategoryRepository;
  readonly lifeAreas: LifeAreaRepository;
  readonly goals: GoalRepository;
  readonly actions: ActionRepository;
  readonly audit: AuditLogger;
}

export class ManageExpenseUseCase {
  readonly #expenses: ExpenseRepository;
  readonly #expenseCategories: ExpenseCategoryRepository;
  readonly #lifeAreas: LifeAreaRepository;
  readonly #goals: GoalRepository;
  readonly #actions: ActionRepository;
  readonly #audit: AuditLogger;

  constructor(dependencies: ManageExpenseDependencies) {
    this.#expenses = dependencies.expenses;
    this.#expenseCategories = dependencies.expenseCategories;
    this.#lifeAreas = dependencies.lifeAreas;
    this.#goals = dependencies.goals;
    this.#actions = dependencies.actions;
    this.#audit = dependencies.audit;
  }

  list(userId: string, options: ListExpensesOptions): Promise<ExpensePage> {
    return this.#expenses.list(userId, options);
  }

  summarize(userId: string, options: ExpenseSummaryOptions): Promise<ExpenseSummary> {
    return this.#expenses.summarize(userId, options);
  }

  /** 单条读取：不存在 / 已软删 / 非本人一律抛 404（不泄露存在性）。 */
  findById(userId: string, expenseId: string): Promise<Expense> {
    return this.#requireExpense(userId, expenseId);
  }

  async create(userId: string, input: ExpenseCreateInput, requestId?: string): Promise<Expense> {
    await this.#assertAssociations(userId, {
      categoryId: input.categoryId,
      lifeAreaId: input.lifeAreaId,
      goalId: input.goalId,
      actionId: input.actionId,
    });

    const created = await this.#expenses.create(userId, input);
    this.#record('DATA_CREATED', userId, requestId);
    return created;
  }

  async update(
    userId: string,
    expenseId: string,
    expectedVersion: number,
    patch: ExpensePatch,
    requestId?: string,
  ): Promise<Expense> {
    const current = await this.#requireExpense(userId, expenseId);

    // 关联校验以"补丁生效后"的状态为准：同一次 PATCH 可能同时换目标与行动。
    await this.#assertAssociations(
      userId,
      {
        categoryId: patch.categoryId,
        lifeAreaId: patch.lifeAreaId,
        goalId: patch.goalId,
        actionId: patch.actionId,
      },
      current,
    );

    const updated = await this.#expenses.update(userId, expenseId, expectedVersion, patch);
    this.#record('DATA_UPDATED', userId, requestId);
    return updated;
  }

  /**
   * 软删（FR-052）。
   *
   * 返回被删行本身：A4 第 2 步要拿 `deletedAt` 与 `version` 去渲染撤销 Toast 与
   * 后续的恢复请求，再查一次既多余又可能与撤销窗口竞争。
   */
  async delete(userId: string, expenseId: string, requestId?: string): Promise<Expense> {
    const deleted = await this.#expenses.softDelete(userId, expenseId);
    if (deleted === null) {
      // 重复删除与删除不存在的开销同义：软删后的开销不在任何查询中，按 404 处理。
      throw new NotFoundError('开销不存在');
    }
    this.#record('DATA_DELETED', userId, requestId);
    return deleted;
  }

  /** 撤销软删（A4 第 3 步）。带 `version`，避免覆盖撤销窗口内发生的编辑。 */
  async restore(
    userId: string,
    expenseId: string,
    expectedVersion: number,
    requestId?: string,
  ): Promise<Expense> {
    const restored = await this.#expenses.restore(userId, expenseId, expectedVersion);
    this.#record('DATA_RESTORED', userId, requestId);
    return restored;
  }

  /**
   * 校验关联实体的归属与可用性。
   *
   * `undefined` 表示"补丁没有提供这一项"（跳过校验）；`null` 表示"显式清空"
   * （无需校验）；非空才查归属。`current` 只在更新路径给出——它让"保持原分类/
   * 原目标"有据可依（A3 的"只可保持或换新"）。
   */
  async #assertAssociations(
    userId: string,
    patch: AssociationPatch,
    current?: Expense,
  ): Promise<void> {
    const categoryId = patch.categoryId;
    if (categoryId !== undefined && categoryId !== null) {
      const category = await this.#expenseCategories.findById(userId, categoryId);
      if (category === null) {
        throw new NotFoundError('分类不存在');
      }
      // 新建时 `current` 为 undefined（无原分类可保持）；更新时只有"换成另一个
      // 已停用分类"才拒绝，"保持原来那个已停用分类"放行。
      const keepingCurrent = current !== undefined && current.categoryId === categoryId;
      if (category.isArchived && !keepingCurrent) {
        throw new ValidationError('该分类已停用，不能用于新的开销');
      }
    }

    if (patch.lifeAreaId != null) {
      // 已归档领域不出现在选择器（IAM-003），因此也不接受被新开销引用——
      // 对调用方而言它与"不存在"同义（不泄露归档项的存在性）。
      const area = await this.#lifeAreas.findById(userId, patch.lifeAreaId);
      if (area === null || area.isArchived) {
        throw new NotFoundError('生活领域不存在');
      }
    }

    // 补丁生效后的关联：用于判定"给出 actionId 时 goalId 必须存在且是其父目标"。
    const effectiveGoalId = patch.goalId === undefined ? (current?.goalId ?? null) : patch.goalId;
    const effectiveActionId =
      patch.actionId === undefined ? (current?.actionId ?? null) : patch.actionId;

    if (patch.goalId != null) {
      // 归档目标**允许**关联（拍板 4③）：历史事实不因归档消失，只做存在性校验。
      const goal = await this.#goals.findById(userId, patch.goalId);
      if (goal === null) {
        throw new NotFoundError('关联的目标不存在');
      }
    }

    if (patch.actionId != null) {
      const action = await this.#actions.findById(userId, patch.actionId);
      if (action === null) {
        throw new NotFoundError('关联的行动不存在');
      }
      if (effectiveGoalId === null) {
        throw new ValidationError('选择行动时必须同时指定它所属的目标');
      }
      if (action.goalId !== effectiveGoalId) {
        throw new ValidationError('关联的行动不属于指定的目标');
      }
    }

    // 清空目标却把行动留着，会得到一个"行动悬空"的行——同步与汇总都会读不懂它。
    if (effectiveActionId !== null && effectiveGoalId === null) {
      throw new ValidationError('选择行动时必须同时指定它所属的目标');
    }
  }

  async #requireExpense(userId: string, expenseId: string): Promise<Expense> {
    const expense = await this.#expenses.findById(userId, expenseId);
    if (expense === null) {
      throw new NotFoundError('开销不存在');
    }
    return expense;
  }

  #record(type: AuditEventType, userId: string, requestId: string | undefined): void {
    this.#audit.record({
      type,
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
      // 备注与金额属敏感内容（§9：note 按敏感内容对待），只记事件类型与匿名标识。
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
}
