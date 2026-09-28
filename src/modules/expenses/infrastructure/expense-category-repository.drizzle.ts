/**
 * 支出分类仓储的 Drizzle 实现（EXP-001）。
 *
 * 与生活领域仓储同样的三层职责：行↔实体映射、事务边界、数据库错误 → 领域错误。
 */
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import { expenseCategories, type ExpenseCategoryRow } from '@/infrastructure/database/schema.ts';
import { ConflictError, InvariantError, NotFoundError } from '@/shared/errors/app-error.ts';
import { hasPostgresErrorCode } from '@/shared/errors/postgres-error.ts';

import { DEFAULT_EXPENSE_CATEGORIES } from '../domain/default-expense-categories.ts';
import type {
  ExpenseCategory,
  ExpenseCategoryCreateInput,
  ExpenseCategoryPatch,
} from '../domain/expense-category.ts';
import type {
  ExpenseCategoryRepository,
  ListExpenseCategoriesOptions,
} from '../domain/expense-category-repository.ts';

/** PostgreSQL 的唯一约束冲突。 */
const UNIQUE_VIOLATION = '23505';

/** 行 → 领域实体。 */
function toExpenseCategory(row: ExpenseCategoryRow): ExpenseCategory {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    sortOrder: row.sortOrder,
    isDefault: row.isDefault,
    isArchived: row.isArchived,
    version: row.version,
  };
}

/**
 * 把唯一约束冲突翻译成领域冲突错误。
 *
 * 名称唯一性**不靠预检**（先 SELECT 再 INSERT）：两步之间存在窗口，并发或重试都能
 * 让它失效；而库里的部分唯一索引（`WHERE is_archived = false`）是原子的。
 */
function rethrowNameConflict(error: unknown, name: string): never {
  if (hasPostgresErrorCode(error, UNIQUE_VIOLATION)) {
    throw new ConflictError(`已存在同名的未停用分类：${name}`);
  }
  throw error;
}

export function createExpenseCategoryRepository(db: Database): ExpenseCategoryRepository {
  /**
   * 首次访问该用户的分类时写入九个默认分类（幂等）。
   *
   * 必须在**调用方的事务内**执行：判空与写入分开做的话，两次并发首访会各自看到
   * "0 行"并各插一遍九行。`onConflictDoNothing()` 兜住剩余窗口——部分唯一索引
   * （`WHERE is_archived = false`）仍然是幂等的硬保证。
   */
  async function seedIfEmpty(tx: Database, userId: string): Promise<void> {
    const counted = await tx
      .select({ value: sql<number>`COUNT(*)` })
      .from(expenseCategories)
      .where(eq(expenseCategories.userId, userId));

    if (Number(counted[0]?.value ?? 0) > 0) {
      return;
    }

    await tx
      .insert(expenseCategories)
      .values(
        DEFAULT_EXPENSE_CATEGORIES.map((category) => ({
          userId,
          name: category.name,
          sortOrder: category.sortOrder,
          isDefault: true,
        })),
      )
      .onConflictDoNothing();
  }

  return {
    async listByUser(
      userId: string,
      options: ListExpenseCategoriesOptions,
    ): Promise<readonly ExpenseCategory[]> {
      return db.transaction(async (tx) => {
        await seedIfEmpty(tx, userId);

        const rows = await tx
          .select()
          .from(expenseCategories)
          .where(
            options.includeArchived
              ? eq(expenseCategories.userId, userId)
              : and(eq(expenseCategories.userId, userId), eq(expenseCategories.isArchived, false)),
          )
          .orderBy(expenseCategories.sortOrder);
        return rows.map(toExpenseCategory);
      });
    },

    async findById(userId: string, categoryId: string): Promise<ExpenseCategory | null> {
      const rows = await db
        .select()
        .from(expenseCategories)
        // 作用域与 id 一起进 WHERE：少了 userId 就是一个"猜 id 就能读到别人数据"的入口。
        .where(and(eq(expenseCategories.userId, userId), eq(expenseCategories.id, categoryId)))
        .limit(1);

      const row = rows[0];
      return row === undefined ? null : toExpenseCategory(row);
    },

    async create(userId: string, input: ExpenseCategoryCreateInput): Promise<ExpenseCategory> {
      try {
        return await db.transaction(async (tx) => {
          await seedIfEmpty(tx, userId);

          // 新分类排到末位。默认分类占 1–9，所以空列表（不可能，播种刚补过）的
          // 首项取 1；用 COUNT 会在删/停用后产生重复序号。
          const nextOrder = await tx
            .select({ value: sql<number>`COALESCE(MAX(${expenseCategories.sortOrder}), 0) + 1` })
            .from(expenseCategories)
            .where(eq(expenseCategories.userId, userId));

          const sortOrder = Number(nextOrder[0]?.value ?? 1);

          const inserted = await tx
            .insert(expenseCategories)
            .values({ userId, name: input.name, sortOrder, isDefault: false })
            .returning();

          const row = inserted[0];
          if (row === undefined) {
            throw new InvariantError({ message: '创建支出分类后数据库未返回记录' });
          }
          return toExpenseCategory(row);
        });
      } catch (error) {
        rethrowNameConflict(error, input.name);
      }
    },

    async update(
      userId: string,
      categoryId: string,
      patch: ExpenseCategoryPatch,
    ): Promise<ExpenseCategory> {
      try {
        const updated = await db
          .update(expenseCategories)
          .set({ ...patch, version: sql`${expenseCategories.version} + 1` })
          .where(and(eq(expenseCategories.userId, userId), eq(expenseCategories.id, categoryId)))
          .returning();

        const row = updated[0];
        if (row === undefined) {
          // 作用域不匹配与"记录不存在"都走这里，且返回同一个错误：调用方无法区分
          // 二者，因此"猜 id"既不能读到也不能推断出别人的数据。
          throw new NotFoundError('支出分类不存在');
        }
        return toExpenseCategory(row);
      } catch (error) {
        rethrowNameConflict(error, patch.name ?? '（重命名）');
      }
    },
  };
}
