/**
 * `life_areas` 行工厂（FND-003）。
 *
 * 它同时是 `goals` 与 `tasks` 的依赖闭包来源：`goals.life_area_id` 为非空外键，
 * 需要在未显式指定时被自动补齐。
 */
import type { FactoryContext, LifeAreaRow, UserRow } from './types.ts';

/** 默认语义色 key。存 key 而非前端色值，与 §4.2 的约定一致。 */
const DEFAULT_COLOR_KEY = 'life-area.blue';

export type LifeAreaFactory = (overrides?: Partial<LifeAreaRow>) => LifeAreaRow;

export interface LifeAreaFactoryDependencies {
  /** 补齐非空外键 `user_id` 所需的用户工厂。 */
  readonly createUser: (overrides?: Partial<UserRow>) => UserRow;
}

/**
 * 创建生活领域工厂。
 *
 * @param context 共享随机源、ID 与时钟。
 * @param dependencies 补齐非空外键所需的依赖工厂。
 * @returns 生活领域工厂；同一实例内部序号递增，使 `name` 与 `sort_order` 天然唯一且有序。
 */
export function createLifeAreaFactory(
  context: FactoryContext,
  dependencies: LifeAreaFactoryDependencies,
): LifeAreaFactory {
  let sequence = 0;

  return (overrides = {}) => {
    sequence += 1;
    const timestamp = context.clock.isoNow();

    // `user_id` 是非空外键：缺省时补一行同用户，而不是留空或写入占位字符串。
    // 留空会让产出的行在形状上就不合法，把调用方的错误推迟到落库时才暴露。
    const userId = overrides.user_id ?? dependencies.createUser().id;

    const row: LifeAreaRow = {
      id: context.ids.next(),
      user_id: userId,
      name: `生活领域 ${sequence}`,
      color_key: DEFAULT_COLOR_KEY,
      sort_order: sequence,
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
