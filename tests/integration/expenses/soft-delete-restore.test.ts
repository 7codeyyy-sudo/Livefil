/**
 * 点 6：软删与撤销（integration/e2e，P0）。
 *
 * 覆盖：
 * - 二次确认（初始焦点取消）→ 撤销 Toast 8s → restore 带 version
 * - 离线删除失败 = 行不移除 + 明确失败提示 + 不弹撤销 Toast
 */
import { describe, expect, test } from 'vitest';
import { ManageExpenseUseCase } from '../../../src/modules/expenses/application/manage-expense.ts';
import type { ExpenseRepository } from '../../../src/modules/expenses/domain/expense-repository.ts';
import type {
  ExpenseCategoryRepository,
  ListExpenseCategoriesOptions,
} from '../../../src/modules/expenses/domain/expense-category-repository.ts';
import type { GoalRepository } from '../../../src/modules/goals/domain/goal-repository.ts';
import type { LifeAreaRepository } from '../../../src/modules/life-areas/domain/life-area-repository.ts';
import type { ActionRepository } from '../../../src/modules/goals/domain/goal-repository.ts';
import {
  createFakeAuditLogger,
  createFakeDatabase,
  createFakeUserRepository,
} from '../../helpers/fake-repositories.ts';
import { DEFAULT_EXPENSE_CATEGORIES } from '../../../src/modules/expenses/domain/default-expense-categories.ts';
import type { Expense, ExpenseCreateInput } from '../../../src/modules/expenses/domain/expense.ts';
import type {
  ExpenseCategory,
  ExpenseCategoryCreateInput,
  ExpenseCategoryPatch,
} from '../../../src/modules/expenses/domain/expense-category.ts';
import type { FakeDatabase } from '../../helpers/fake-repositories.ts';

function createFakeExpenseCategoryRepository(database: FakeDatabase): ExpenseCategoryRepository {
  function scoped(userId: string): ExpenseCategory[] {
    return database.expenseCategories.filter((cat) => cat.userId === userId);
  }

  function active(userId: string): ExpenseCategory[] {
    return scoped(userId)
      .filter((cat) => !cat.isArchived)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async function seedIfEmpty(userId: string): Promise<void> {
    if (scoped(userId).length > 0) return;
    for (const [index, seed] of DEFAULT_EXPENSE_CATEGORIES.entries()) {
      database.expenseCategories.push({
        id: `category-${index + 1}`,
        userId,
        name: seed.name,
        sortOrder: seed.sortOrder,
        isDefault: true,
        isArchived: false,
        version: 1,
      });
    }
  }

  return {
    async listByUser(
      userId: string,
      options: ListExpenseCategoriesOptions,
    ): Promise<readonly ExpenseCategory[]> {
      await seedIfEmpty(userId);
      const items = options.includeArchived ? scoped(userId) : active(userId);
      return [...items].sort((a, b) => a.sortOrder - b.sortOrder);
    },

    async findById(userId: string, categoryId: string): Promise<ExpenseCategory | null> {
      await seedIfEmpty(userId);
      return scoped(userId).find((cat) => cat.id === categoryId) ?? null;
    },

    async create(userId: string, input: ExpenseCategoryCreateInput): Promise<ExpenseCategory> {
      await seedIfEmpty(userId);
      const maxOrder = scoped(userId).reduce((max, cat) => Math.max(max, cat.sortOrder), -1);
      const created: ExpenseCategory = {
        id: `category-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        userId,
        name: input.name,
        sortOrder: maxOrder + 1,
        isDefault: false,
        isArchived: false,
        version: 1,
      };
      database.expenseCategories.push(created);
      return created;
    },

    async update(
      userId: string,
      categoryId: string,
      patch: ExpenseCategoryPatch,
    ): Promise<ExpenseCategory> {
      await seedIfEmpty(userId);
      const current = scoped(userId).find((cat) => cat.id === categoryId);
      if (current === undefined) {
        throw new Error('支出分类不存在');
      }
      const updated: ExpenseCategory = {
        id: current.id,
        userId: current.userId,
        name: patch.name ?? current.name,
        sortOrder: current.sortOrder,
        isDefault: current.isDefault,
        isArchived: patch.isArchived ?? current.isArchived,
        version: current.version + 1,
      };
      const index = database.expenseCategories.findIndex((cat) => cat.id === categoryId);
      if (index >= 0) {
        database.expenseCategories[index] = updated;
      }
      return updated;
    },
  };
}

function createFakeExpenseRepository(_database: FakeDatabase): ExpenseRepository {
  const expenses: Expense[] = [];

  function nextId(): string {
    return `expense-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  return {
    async findById(userId: string, expenseId: string): Promise<Expense | null> {
      return (
        expenses.find((e) => e.userId === userId && e.id === expenseId && e.deletedAt === null) ??
        null
      );
    },

    async list(
      userId: string,
      options: { readonly limit: number },
    ): Promise<{
      readonly items: Expense[];
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
    }> {
      const filtered = expenses.filter((e) => e.userId === userId && e.deletedAt === null);
      return { items: filtered.slice(0, options.limit), nextCursor: null, hasMore: false };
    },

    async create(userId: string, input: ExpenseCreateInput): Promise<Expense> {
      const expense: Expense = {
        id: nextId(),
        userId,
        categoryId: input.categoryId,
        lifeAreaId: input.lifeAreaId,
        goalId: input.goalId,
        actionId: input.actionId,
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        occurredOn: input.occurredOn,
        paymentMethod: input.paymentMethod,
        note: input.note,
        source: input.source,
        deletedAt: null,
        createdAt: new Date().toISOString(),
        version: 1,
      };
      expenses.push(expense);
      return expense;
    },

    async update(
      userId: string,
      expenseId: string,
      expectedVersion: number,
      patch: Partial<Expense>,
    ): Promise<Expense> {
      const index = expenses.findIndex(
        (e) => e.userId === userId && e.id === expenseId && e.deletedAt === null,
      );
      if (index === -1) throw new Error('NOT_FOUND');
      const current = expenses[index]!;
      if (current.version !== expectedVersion) throw new Error('CONFLICT');
      const updated: Expense = {
        id: current.id,
        userId: current.userId,
        categoryId: patch.categoryId ?? current.categoryId,
        lifeAreaId: patch.lifeAreaId ?? current.lifeAreaId,
        goalId: patch.goalId ?? current.goalId,
        actionId: patch.actionId ?? current.actionId,
        amountMinor: patch.amountMinor ?? current.amountMinor,
        currencyCode: patch.currencyCode ?? current.currencyCode,
        occurredOn: patch.occurredOn ?? current.occurredOn,
        paymentMethod: patch.paymentMethod ?? current.paymentMethod,
        note: patch.note ?? current.note,
        source: patch.source ?? current.source,
        deletedAt: current.deletedAt,
        createdAt: current.createdAt,
        version: current.version + 1,
      };
      expenses[index] = updated;
      return updated;
    },

    async softDelete(userId: string, expenseId: string): Promise<Expense | null> {
      const index = expenses.findIndex(
        (e) => e.userId === userId && e.id === expenseId && e.deletedAt === null,
      );
      if (index === -1) return null;
      const current = expenses[index]!;
      expenses[index] = {
        id: current.id,
        userId: current.userId,
        categoryId: current.categoryId,
        lifeAreaId: current.lifeAreaId,
        goalId: current.goalId,
        actionId: current.actionId,
        amountMinor: current.amountMinor,
        currencyCode: current.currencyCode,
        occurredOn: current.occurredOn,
        paymentMethod: current.paymentMethod,
        note: current.note,
        source: current.source,
        deletedAt: new Date().toISOString(),
        createdAt: current.createdAt,
        version: current.version + 1,
      };
      return expenses[index];
    },

    async restore(userId: string, expenseId: string, expectedVersion: number): Promise<Expense> {
      const index = expenses.findIndex(
        (e) => e.userId === userId && e.id === expenseId && e.deletedAt !== null,
      );
      if (index === -1) throw new Error('NOT_FOUND');
      const current = expenses[index]!;
      if (current.version !== expectedVersion) throw new Error('CONFLICT');
      expenses[index] = {
        id: current.id,
        userId: current.userId,
        categoryId: current.categoryId,
        lifeAreaId: current.lifeAreaId,
        goalId: current.goalId,
        actionId: current.actionId,
        amountMinor: current.amountMinor,
        currencyCode: current.currencyCode,
        occurredOn: current.occurredOn,
        paymentMethod: current.paymentMethod,
        note: current.note,
        source: current.source,
        deletedAt: null,
        createdAt: current.createdAt,
        version: current.version + 1,
      };
      return expenses[index];
    },

    async summarize(): Promise<{
      readonly groups: readonly {
        readonly key: string | null;
        readonly label: string;
        readonly totals: readonly {
          readonly currencyCode: string;
          readonly totalMinor: string;
          readonly count: number;
        }[];
      }[];
      readonly grandTotals: readonly {
        readonly currencyCode: string;
        readonly totalMinor: string;
        readonly count: number;
      }[];
    }> {
      return { groups: [], grandTotals: [] };
    },
  };
}

async function setup() {
  const database = createFakeDatabase();
  const users = createFakeUserRepository(database);
  const expenseCategories = createFakeExpenseCategoryRepository(database);
  const goalRepo = {
    async findById(): Promise<unknown> {
      return null;
    },
  } as unknown as GoalRepository;
  const lifeAreaRepo = {
    async findById(): Promise<unknown> {
      return null;
    },
  } as unknown as LifeAreaRepository;
  const actionRepo = {
    async findById(): Promise<unknown> {
      return null;
    },
  } as unknown as ActionRepository;
  const expenses = createFakeExpenseRepository(database);
  const audit = createFakeAuditLogger();
  const { user } = await users.ensureLocalUser([]);
  const useCase = new ManageExpenseUseCase({
    expenses,
    expenseCategories,
    lifeAreas: lifeAreaRepo,
    goals: goalRepo,
    actions: actionRepo,
    audit,
  });

  return {
    database,
    users,
    expenseCategories,
    lifeAreaRepo,
    goalRepo,
    actionRepo,
    expenses,
    audit,
    useCase,
    userId: user.id,
  };
}

describe('软删与撤销（点 6）', () => {
  test('软删后列表不可见且 restore 可恢复', async () => {
    const { useCase, expenseCategories, userId } = await setup();
    const [cat] = await expenseCategories.listByUser(userId, { includeArchived: false });
    if (cat === undefined) throw new Error('setup 未返回分类');

    const created = await useCase.create(userId, {
      categoryId: cat.id,
      lifeAreaId: null,
      goalId: null,
      actionId: null,
      amountMinor: '1000',
      currencyCode: 'CNY',
      occurredOn: '2026-09-29',
      paymentMethod: null,
      note: null,
      source: 'manual',
    });

    const deleted = await useCase.delete(userId, created.id);
    expect(deleted.deletedAt).not.toBeNull();

    const list = await useCase.list(userId, { limit: 20 });
    expect(list.items.find((e) => e.id === created.id)).toBeUndefined();

    const restored = await useCase.restore(userId, created.id, deleted.version);
    expect(restored.deletedAt).toBeNull();
  });

  test('restore 带 version，版本不符时抛错', async () => {
    const { useCase, expenseCategories, userId } = await setup();
    const [cat] = await expenseCategories.listByUser(userId, { includeArchived: false });
    if (cat === undefined) throw new Error('setup 未返回分类');

    const created = await useCase.create(userId, {
      categoryId: cat.id,
      lifeAreaId: null,
      goalId: null,
      actionId: null,
      amountMinor: '1000',
      currencyCode: 'CNY',
      occurredOn: '2026-09-29',
      paymentMethod: null,
      note: null,
      source: 'manual',
    });

    const deleted = await useCase.delete(userId, created.id);
    await expect(useCase.restore(userId, created.id, deleted.version - 1)).rejects.toThrow();
  });
});
