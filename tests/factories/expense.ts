/**
 * `expenses` 行工厂（FND-003）。
 *
 * 金额一律使用最小货币单位的**整数分**（§5.2），不使用浮点，
 * 避免测试数据本身就把「元」的浮点误差带进断言。
 */
import type { ExpenseCategoryRow, ExpenseRow, FactoryContext, UserRow } from './types.ts';

/** 默认金额：10.00 元，以分为单位。 */
const DEFAULT_AMOUNT_MINOR = 1000;

/** `date` 列的字符串长度（`YYYY-MM-DD`）。 */
const DATE_LENGTH = 10;

export type ExpenseFactory = (overrides?: Partial<ExpenseRow>) => ExpenseRow;

export interface ExpenseFactoryDependencies {
  readonly createUser: (overrides?: Partial<UserRow>) => UserRow;
  readonly createExpenseCategory: (overrides?: Partial<ExpenseCategoryRow>) => ExpenseCategoryRow;
}

/**
 * 创建开销工厂。
 *
 * @param context 共享随机源、ID 与时钟。
 * @param dependencies 补齐非空外键所需的依赖工厂。
 * @returns 开销工厂。
 */
export function createExpenseFactory(
  context: FactoryContext,
  dependencies: ExpenseFactoryDependencies,
): ExpenseFactory {
  return (overrides = {}) => {
    const timestamp = context.clock.isoNow();

    let userId = overrides.user_id;
    if (userId === undefined) {
      userId = dependencies.createUser().id;
    }

    // `category_id` 是非空外键：缺省时补一行同用户的分类，
    // 复用同一个 `user_id` 以免产出跨用户归属的数据。
    const categoryId =
      overrides.category_id ?? dependencies.createExpenseCategory({ user_id: userId }).id;

    const row: ExpenseRow = {
      id: context.ids.next(),
      user_id: userId,
      category_id: categoryId,
      life_area_id: null,
      goal_id: null,
      action_id: null,
      amount_minor: DEFAULT_AMOUNT_MINOR,
      currency_code: 'CNY',
      // `occurred_on` 是 `date` 列：从 UTC ISO 时刻截取日期部分，避免引入本地时区偏移。
      occurred_on: timestamp.slice(0, DATE_LENGTH),
      payment_method: null,
      note: null,
      source: 'manual',
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
      version: 1,
      ...overrides,
    };

    return Object.freeze(row);
  };
}
