/**
 * `reviews` 行工厂（FND-003）——**最小骨架，待字段定义补全**。
 *
 * 《数据库设计文档》§4.11 目前只有文字说明、没有字段清单，因此这里只固化文档
 * 已经明确表达的内容：复盘周期、结构化快照，以及快照必须携带的 schema 版本
 * （文档要求「不能依赖未来实时重新计算才能展示历史」）。
 *
 * 刻意**不**在这里臆造字段（如情绪评分、完成率等）：工厂一旦先于设计文档定义字段，
 * 后续实现就会以测试数据为准，反向把未经验证的结构固化成事实。
 * 字段补全后的收尾工作已记入《开发任务清单》REVIEW-001。
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
      period: 'daily',
      period_start: timestamp.slice(0, DATE_LENGTH),
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
