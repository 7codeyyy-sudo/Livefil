/**
 * `schedule_blocks` 行工厂（FND-003）。
 *
 * 默认产出一个「已排程的 1 小时时间块」，并保证 §4.6 的约束
 * `ends_at_utc > starts_at_utc` 在任何默认路径下都成立。
 */
import type { FactoryContext, ScheduleBlockRow, UserRow } from './types.ts';

/** 默认时间块时长（分钟）。 */
const DEFAULT_DURATION_MINUTES = 60;

/** 每分钟的毫秒数。 */
const MILLISECONDS_PER_MINUTE = 60_000;

export type ScheduleBlockFactory = (overrides?: Partial<ScheduleBlockRow>) => ScheduleBlockRow;

export interface ScheduleBlockFactoryDependencies {
  /** 补齐非空公共字段 `user_id` 所需的用户工厂。 */
  readonly createUser: (overrides?: Partial<UserRow>) => UserRow;
}

/**
 * 创建时间块工厂。
 *
 * @param context 共享随机源、ID 与时钟。
 * @param dependencies 补齐非空外键所需的依赖工厂。
 * @returns 时间块工厂。
 */
export function createScheduleBlockFactory(
  context: FactoryContext,
  dependencies: ScheduleBlockFactoryDependencies,
): ScheduleBlockFactory {
  return (overrides = {}) => {
    let userId = overrides.user_id;
    if (userId === undefined) {
      userId = dependencies.createUser().id;
    }

    const startsAt = overrides.starts_at_utc ?? context.clock.isoNow();

    // 结束时间从**已确定的开始时间**推导，而不是各自独立取当前时刻：
    // 否则显式传入较早的 starts_at_utc 时，结束时间可能早于开始时间，
    // 直接违反表约束，把工厂变成了「能产出非法数据」的工具。
    const endsAt =
      overrides.ends_at_utc ??
      new Date(
        new Date(startsAt).getTime() + DEFAULT_DURATION_MINUTES * MILLISECONDS_PER_MINUTE,
      ).toISOString();

    const row: ScheduleBlockRow = {
      id: context.ids.next(),
      user_id: userId,
      task_id: null,
      action_id: null,
      starts_at_utc: startsAt,
      ends_at_utc: endsAt,
      // 时区与 UTC 时刻同时保存，保留用户排程时的时区语义（§5.3）。
      timezone: 'Asia/Shanghai',
      source: 'manual',
      status: 'planned',
      conflict_state: 'none',
      created_at: context.clock.isoNow(),
      updated_at: context.clock.isoNow(),
      deleted_at: null,
      version: 1,
      ...overrides,
    };

    return Object.freeze(row);
  };
}
