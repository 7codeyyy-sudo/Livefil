/**
 * `reviews` 行工厂（Phase 7 schema）。
 *
 * 《数据库设计文档》§4.11 已补全字段定义，这里按最终字段实现：
 * - period_key / period / period_start：复盘周期标识
 * - review_type：daily / weekly
 * - snapshot_schema_version：快照 schema 版本
 */
import type { FactoryContext, ReviewRow, UserRow } from './types.ts';

/** 快照结构版本号。首版从 1 起，与文档「必须带 schema 版本」的要求对应。 */
const DEFAULT_SNAPSHOT_SCHEMA_VERSION = 1;

/** `date` 列的字符串长度（`YYYY-MM-DD`）。 */
const DATE_LENGTH = 10;

export type ReviewFactory = (overrides?: Partial<ReviewRow>) => ReviewRow;

export interface ReviewFactoryDependencies {
  /** 补齐非空公共字段 `user_id` 所需的用户工厂。 */
  readonly createUser: (overrides?: Partial<UserRow>) => UserRow;
}

/**
 * 创建复盘工厂。
 *
 * @param context 共享随机源、ID 与时钟。
 * @param dependencies 补齐非空外键所需的依赖工厂。
 * @returns 复盘工厂；默认产出一条当日复盘骨架。
 */
export function createReviewFactory(
  context: FactoryContext,
  dependencies: ReviewFactoryDependencies,
): ReviewFactory {
  return (overrides = {}) => {
    const timestamp = context.clock.isoNow();

    let userId = overrides.user_id;
    if (userId === undefined) {
      userId = dependencies.createUser().id;
    }

    const row: ReviewRow = {
      id: context.ids.next(),
      user_id: userId,
      review_type: 'daily',
      period_key: timestamp.slice(0, DATE_LENGTH),
      period: 'daily',
      period_start: timestamp.slice(0, DATE_LENGTH),
      answers: null,
      energy_level: null,
      snapshot: null,
      snapshot_schema_version: DEFAULT_SNAPSHOT_SCHEMA_VERSION,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
      version: 1,
      ...overrides,
    };

    return Object.freeze(row);
  };
}
