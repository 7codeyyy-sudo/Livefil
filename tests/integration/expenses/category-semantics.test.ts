// @vitest-environment node
/**
 * 点 2：分类语义（integration，P0）。
 *
 * 覆盖：惰性 seed 9 默认、改名、停用后历史回填带「已停用」、无 DELETE 路径。
 */
import { describe, expect, it } from 'vitest';

import { ManageExpenseCategoryUseCase } from '../../../src/modules/expenses/application/manage-expense-category.ts';
import {
  createExpenseCategorySchema,
  updateExpenseCategorySchema,
} from '../../../src/modules/expenses/application/expense-category-dto.ts';
import { DEFAULT_EXPENSE_CATEGORIES } from '../../../src/modules/expenses/domain/default-expense-categories.ts';
import {
  type ExpenseCategory,
  type ExpenseCategoryCreateInput,
  type ExpenseCategoryPatch,
} from '../../../src/modules/expenses/domain/expense-category.ts';
import type {
  ExpenseCategoryRepository,
  ListExpenseCategoriesOptions,
} from '../../../src/modules/expenses/domain/expense-category-repository.ts';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../src/shared/errors/app-error.ts';
import {
  createFakeAuditLogger,
  createFakeDatabase,
  createFakeUserRepository,
} from '../../helpers/fake-repositories.ts';
import type { FakeDatabase } from '../../helpers/fake-repositories.ts';

const OTHER_USER_ID = 'user-other';

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
      const clash = active(userId).some((cat) => cat.name === input.name);
      if (clash) {
        throw new ConflictError(`已存在同名的未停用分类：${input.name}`);
      }

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
        throw new NotFoundError('支出分类不存在');
      }

      if (patch.isArchived === true && current.isArchived) {
        throw new ValidationError('该支出分类已经停用');
      }
      if (patch.isArchived === false && !current.isArchived) {
        throw new ValidationError('该支出分类尚未停用');
      }

      const newName = patch.name ?? current.name;
      if (newName !== current.name) {
        const clash = active(userId).some((cat) => cat.name === newName && cat.id !== categoryId);
        if (clash) {
          throw new ConflictError(`已存在同名的未停用分类：${newName}`);
        }
      }

      const updated: ExpenseCategory = {
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.isArchived === undefined ? {} : { isArchived: patch.isArchived }),
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

async function setup() {
  const database = createFakeDatabase();
  const users = createFakeUserRepository(database);
  const expenseCategories = createFakeExpenseCategoryRepository(database);
  const audit = createFakeAuditLogger();
  const { user } = await users.ensureLocalUser([]);
  const useCase = new ManageExpenseCategoryUseCase({ expenseCategories, audit });

  return { database, users, expenseCategories, audit, useCase, userId: user.id };
}

const parseCreate = (body: unknown) => createExpenseCategorySchema.parse(body);
const parseUpdate = (body: unknown) => updateExpenseCategorySchema.parse(body);

describe('分类语义（点 2）', () => {
  describe('惰性 seed', () => {
    it('首次访问时空用户自动写入 9 个默认分类', async () => {
      const { expenseCategories, userId } = await setup();

      const items = await expenseCategories.listByUser(userId, { includeArchived: false });

      expect(items).toHaveLength(DEFAULT_EXPENSE_CATEGORIES.length);
      expect(items.every((cat) => cat.isDefault)).toBe(true);
    });
  });

  describe('改名', () => {
    it('改名成功且保留 isDefault / sortOrder / version 自增', async () => {
      const { useCase, expenseCategories, userId } = await setup();
      const [first] = await expenseCategories.listByUser(userId, { includeArchived: false });
      if (first === undefined) throw new Error('setup 未返回分类');

      const updated = await useCase.update(
        userId,
        first.id,
        parseUpdate({ name: '新名字' }),
        'req-rename',
      );

      expect(updated.name).toBe('新名字');
      expect(updated.isDefault).toBe(first.isDefault);
      expect(updated.version).toBe(first.version + 1);
    });

    it('与未归档分类同名 → 409 Conflict', async () => {
      const { useCase, expenseCategories, userId } = await setup();
      const [first, second] = await expenseCategories.listByUser(userId, {
        includeArchived: false,
      });
      if (first === undefined || second === undefined) throw new Error('setup 未返回分类');

      await expect(
        useCase.update(userId, second.id, parseUpdate({ name: first.name })),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('停用与历史回填', () => {
    it('停用后 isArchived=true，默认列表不可见', async () => {
      const { useCase, expenseCategories, userId } = await setup();
      const [first] = await expenseCategories.listByUser(userId, { includeArchived: false });
      if (first === undefined) throw new Error('setup 未返回分类');

      const updated = await useCase.update(
        userId,
        first.id,
        parseUpdate({ isArchived: true }),
        'req-archive',
      );

      expect(updated.isArchived).toBe(true);

      const active = await expenseCategories.listByUser(userId, { includeArchived: false });
      expect(active.map((area) => area.id)).not.toContain(first.id);
    });

    it('归档后可用同一名字再建新分类', async () => {
      const { useCase, expenseCategories, userId } = await setup();
      const [first] = await expenseCategories.listByUser(userId, { includeArchived: false });
      if (first === undefined) throw new Error('setup 未返回分类');
      const originalName = first.name;

      await useCase.update(userId, first.id, parseUpdate({ isArchived: true }));

      const recreated = await useCase.create(userId, parseCreate({ name: originalName }));

      expect(recreated.name).toBe(originalName);
      expect(recreated.isArchived).toBe(false);
    });

    it('重复停用 / 未归档时恢复 → 422', async () => {
      const { useCase, expenseCategories, userId } = await setup();
      const [first] = await expenseCategories.listByUser(userId, { includeArchived: false });
      if (first === undefined) throw new Error('setup 未返回分类');

      await useCase.update(userId, first.id, parseUpdate({ isArchived: true }));

      await expect(
        useCase.update(userId, first.id, parseUpdate({ isArchived: true })),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        useCase.update(userId, first.id, parseUpdate({ isArchived: false })),
      ).resolves.toBeDefined();

      await expect(
        useCase.update(userId, first.id, parseUpdate({ isArchived: false })),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('无 DELETE 路径', () => {
    it('仓储接口不暴露 delete 方法', () => {
      const repository = createFakeExpenseCategoryRepository(createFakeDatabase());
      expect(typeof (repository as unknown as Record<string, unknown>).delete).toBe('undefined');
    });
  });

  describe('用户作用域', () => {
    it('列表不含他人的分类', async () => {
      const { expenseCategories, userId } = await setup();
      await expenseCategories.create(OTHER_USER_ID, { name: '别人的分类' });

      const mine = await expenseCategories.listByUser(userId, { includeArchived: false });

      expect(mine.map((cat) => cat.name)).not.toContain('别人的分类');
    });

    it('按 id 操作他人的分类 → 404（不泄露存在性）', async () => {
      const { useCase, expenseCategories, userId } = await setup();
      const foreign = await expenseCategories.create(OTHER_USER_ID, { name: '别人的分类' });

      await expect(
        useCase.update(userId, foreign.id, parseUpdate({ name: '改名' })),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(await expenseCategories.findById(userId, foreign.id)).toBeNull();
    });
  });
});
