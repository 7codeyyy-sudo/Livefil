/**
 * 测试数据工厂入口（FND-003）。
 *
 * 一次 `createFactories()` 调用产出一整套互相共享随机源、ID 序列与时钟的工厂，
 * 并由调用方通过 `seed` 固定整批数据的形态：同一 seed 下，实体字段、ID、时间戳
 * 全部可复现，失败可以原样重放。
 *
 * 两处刻意的设计取舍：
 *
 * 1. **默认时间不动**。时钟只在被显式 `advance` 时前进，`created_at` 因此稳定；
 *    需要「先建任务、后建排程」这类时间先后关系时，由测试自行推进时钟。
 *
 * 2. **默认不跨实体共享行**。`lifeArea()` 与 `task()` 各自缺省创建自己的用户，
 *    而不是隐式复用同一个「当前用户」。隐式共享状态是测试里最难排查的一类干扰：
 *    它让用例之间产生顺序依赖。需要同一用户名下多行数据时，显式传递 `user_id`：
 *
 *    ```ts
 *    const factories = createFactories({ seed: 1 });
 *    const user = factories.user();
 *    const task = factories.task({ user_id: user.id });
 *    ```
 *
 * 工厂只保证单行的**形状**合法（非空字段有值、枚举取值合法、时间区间有序），
 * 不保证跨表引用在数据库里真实存在——引用的一致性由数据库外键约束负责，
 * 这一点在未接入数据库的当前阶段尤其需要调用方知悉。
 *
 * 用法：
 *
 * ```ts
 * const factories = createFactories({ seed: 42 });
 * const user = factories.user();
 * const expense = factories.expense({ user_id: user.id, amount_minor: 1999 });
 * ```
 */

import { createClock, type Clock } from './clock.ts';
import { createExpenseCategoryFactory, type ExpenseCategoryFactory } from './expense-category.ts';
import { createExpenseFactory, type ExpenseFactory } from './expense.ts';
import { createGoalFactory, type GoalFactory } from './goal.ts';
import { createIdFactory, type IdFactory } from './ids.ts';
import { createLifeAreaFactory, type LifeAreaFactory } from './life-area.ts';
import { createRandom, type RandomSource } from './random.ts';
import { createReviewFactory, type ReviewFactory } from './review.ts';
import { createScheduleBlockFactory, type ScheduleBlockFactory } from './schedule.ts';
import { createTaskFactory, type TaskFactory } from './task.ts';
import type { FactoryContext } from './types.ts';
import { createUserFactory, type UserFactory } from './user.ts';

export interface FactoryOptions {
  /** 随机种子；缺省时使用 {@link createRandom} 的固定默认种子。 */
  readonly seed?: number | string;
  /** 时钟起始时刻；缺省时使用 {@link createClock} 的固定默认时刻。 */
  readonly now?: string | Date;
}

/** 一整套共享同一随机源、ID 序列与时钟的工厂。 */
export interface TestFactories {
  readonly random: RandomSource;
  readonly ids: IdFactory;
  readonly clock: Clock;
  readonly user: UserFactory;
  readonly lifeArea: LifeAreaFactory;
  readonly goal: GoalFactory;
  readonly task: TaskFactory;
  readonly scheduleBlock: ScheduleBlockFactory;
  readonly expenseCategory: ExpenseCategoryFactory;
  readonly expense: ExpenseFactory;
  readonly review: ReviewFactory;
}

/**
 * 创建整套测试数据工厂。
 *
 * @param options 种子与起始时刻。
 * @returns 冻结后的工厂集合。
 */
export function createFactories(options: FactoryOptions = {}): TestFactories {
  const random = createRandom(options.seed);
  const ids = createIdFactory(random);
  const clock = createClock(options.now);

  const context: FactoryContext = Object.freeze({ random, ids, clock });

  const user = createUserFactory(context);
  const lifeArea = createLifeAreaFactory(context, { createUser: user });
  const goal = createGoalFactory(context, { createUser: user, createLifeArea: lifeArea });
  const task = createTaskFactory(context, { createUser: user });
  const scheduleBlock = createScheduleBlockFactory(context, { createUser: user });
  const expenseCategory = createExpenseCategoryFactory(context, { createUser: user });
  const expense = createExpenseFactory(context, {
    createUser: user,
    createExpenseCategory: expenseCategory,
  });
  const review = createReviewFactory(context, { createUser: user });

  return Object.freeze({
    random,
    ids,
    clock,
    user,
    lifeArea,
    goal,
    task,
    scheduleBlock,
    expenseCategory,
    expense,
    review,
  });
}

export type * from './types.ts';
export type { Clock } from './clock.ts';
export type { IdFactory } from './ids.ts';
export type { RandomSource } from './random.ts';
export type { UserFactory } from './user.ts';
export type { LifeAreaFactory } from './life-area.ts';
export type { GoalFactory } from './goal.ts';
export type { TaskFactory } from './task.ts';
export type { ScheduleBlockFactory } from './schedule.ts';
export type { ExpenseCategoryFactory } from './expense-category.ts';
export type { ExpenseFactory } from './expense.ts';
export type { ReviewFactory } from './review.ts';
