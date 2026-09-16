/**
 * `users` 行工厂（FND-003）。
 *
 * 提供「随机测试用户」：每次调用产出一个字段齐备、互相之间不会碰撞的本地模式用户。
 */
import type { FactoryContext, UserRow } from './types.ts';

/**
 * 测试邮箱域名。
 * `example.com` 是 RFC 2606 保留域，**永远**不会指向真实收件方，
 * 避免测试数据意外命中真实邮箱服务或被当成个人信息。
 */
const TEST_EMAIL_DOMAIN = 'example.com';

/** 默认时区。取中国标准时间，与项目默认 `locale` / `currency_code` 一致。 */
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** 默认安静时段的起止（本地时间字符串，对应 `time` 列）。 */
const DEFAULT_QUIET_HOURS_START = '22:00';

/** @see DEFAULT_QUIET_HOURS_START */
const DEFAULT_QUIET_HOURS_END = '07:00';

/** 默认周起始日：1 = 周一。 */
const DEFAULT_WEEK_STARTS_ON = 1;

export type UserFactory = (overrides?: Partial<UserRow>) => UserRow;

/**
 * 创建用户工厂。
 *
 * @param context 共享随机源、ID 与时钟。
 * @returns 用户工厂；同一工厂实例内部序号递增，保证 `email` 不重复。
 */
export function createUserFactory(context: FactoryContext): UserFactory {
  let sequence = 0;

  return (overrides = {}) => {
    sequence += 1;
    const timestamp = context.clock.isoNow();

    const row: UserRow = {
      id: context.ids.next(),
      email: `user-${sequence}@${TEST_EMAIL_DOMAIN}`,
      display_name: `测试用户 ${sequence}`,
      mode: 'local',
      locale: 'zh-CN',
      timezone: DEFAULT_TIMEZONE,
      currency_code: 'CNY',
      week_starts_on: DEFAULT_WEEK_STARTS_ON,
      reminder_enabled: true,
      quiet_hours_start: DEFAULT_QUIET_HOURS_START,
      quiet_hours_end: DEFAULT_QUIET_HOURS_END,
      created_at: timestamp,
      updated_at: timestamp,
      ...overrides,
    };

    return Object.freeze(row);
  };
}
