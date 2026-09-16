/**
 * `goals` 行工厂（FND-003）。
 *
 * `goals.life_area_id` 是非空外键，因此本工厂在未显式指定时，
 * 会自动补一行**同用户**的生活领域，保证产出对象在形状与归属上同时自洽。
 */
import type { FactoryContext, GoalRow, LifeAreaRow, UserRow } from './types.ts';

/** 目标名称前缀，配合内部序号生成可读且互不相同的默认名。 */
const DEFAULT_NAME_PREFIX = '目标';

export type GoalFactory = (overrides?: Partial<GoalRow>) => GoalRow;

export interface GoalFactoryDependencies {
  readonly createUser: (overrides?: Partial<UserRow>) => UserRow;
  readonly createLifeArea: (overrides?: Partial<LifeAreaRow>) => LifeAreaRow;
}

/**
 * 创建目标工厂。
 *
 * @param context 共享随机源、ID 与时钟。
 * @param dependencies 补齐非空外键所需的依赖工厂。
 * @returns 目标工厂。
 */
export function createGoalFactory(
  context: FactoryContext,
  dependencies: GoalFactoryDependencies,
): GoalFactory {
  let sequence = 0;

  return (overrides = {}) => {
    sequence += 1;
    const timestamp = context.clock.isoNow();

    // `user_id` 属于公共字段且非空，无论是否显式指定都必须有值。
    let userId = overrides.user_id;
    if (userId === undefined) {
      userId = dependencies.createUser().id;
    }

    // 补齐领域时复用同一个 `user_id`：否则会产出「目标属于 A、领域属于 B」
    // 这种形状合法但语义错误的数据，而这类问题往往要到权限校验时才暴露。
    const lifeAreaId =
      overrides.life_area_id ?? dependencies.createLifeArea({ user_id: userId }).id;

    const row: GoalRow = {
      id: context.ids.next(),
      user_id: userId,
      life_area_id: lifeAreaId,
      name: `${DEFAULT_NAME_PREFIX} ${sequence}`,
      reason: null,
      status: 'active',
      start_date: null,
      target_date: null,
      result_metric: null,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
      version: 1,
      ...overrides,
    };

    return Object.freeze(row);
  };
}
