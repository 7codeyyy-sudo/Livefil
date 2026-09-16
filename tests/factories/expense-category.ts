/**
 * `expense_categories` 行工厂（FND-003）。
 *
 * 它同时是 `expenses` 的依赖闭包来源：`expenses.category_id` 为非空外键。
 */
import type { ExpenseCategoryRow, FactoryContext, UserRow } from './types.ts';

/** 分类名称前缀，配合内部序号生成可读且互不相同的默认名。 */
const DEFAULT_NAME_PREFIX = '开销分类';

export type ExpenseCategoryFactory = (
  overrides?: Partial<ExpenseCategoryRow>,
) => ExpenseCategoryRow;

export interface ExpenseCategoryFactoryDependencies {
  /** 补齐非空公共字段 `user_id` 所需的用户工厂。 */
  readonly createUser: (overrides?: Partial<UserRow>) => UserRow;
}

/**
 * 创建开销分类工厂。
 *
 * @param context 共享随机源、ID 与时钟。
 * @param dependencies 补齐非空外键所需的依赖工厂。
 * @returns 开销分类工厂。
 */
export function createExpenseCategoryFactory(
  context: FactoryContext,
  dependencies: ExpenseCategoryFactoryDependencies,
): ExpenseCategoryFactory {
  let sequence = 0;

  return (overrides = {}) => {
    sequence += 1;
    const timestamp = context.clock.isoNow();

    let userId = overrides.user_id;
    if (userId === undefined) {
      userId = dependencies.createUser().id;
    }

    const row: ExpenseCategoryRow = {
      id: context.ids.next(),
      user_id: userId,
      name: `${DEFAULT_NAME_PREFIX} ${sequence}`,
      is_default: false,
      is_archived: false,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
      version: 1,
      ...overrides,
    };

    return Object.freeze(row);
  };
}
