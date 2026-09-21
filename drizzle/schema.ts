/**
 * 数据库 schema（DB-001，《数据库设计文档》§3、§4.1、§4.2）。
 *
 * ## 位置
 *
 * 放**项目根的 `drizzle/`**，与 `src/` 平级——这是《详细设计说明书》§2 的目录契约
 * 与 §11 迁移策略指定的位置（"schema（`drizzle/`，经 §2 目录契约）"）。刻意
 * 不塞进 `src/shared/`：那里的七个子目录是一份被 FND-004 验收精确断言的契约，
 * 而 schema 属于数据层、不属于共享内核。
 *
 * ## 只建本批（Phase 2 本地单用户批次）需要的两张表
 *
 * `users` 与 `life_areas`。其余 12 张表随各自模块任务落地——现在建它们只会得到
 * 一批没有消费者、也无人验证的列定义。
 *
 * ## 时间一律 `timestamptz`
 *
 * 按 §3 公共字段规范与 SRS 的时间要求（UTC 存储 + 用户时区语义）：带时区的
 * 时间戳在库里始终是 UTC 瞬时，用户时区只在展示与"某一天"的边界计算时参与。
 * 用 `timestamp`（无时区）会把"这一刻"降级成"墙上时间"，跨时区必然出错。
 */
import {
  bigint,
  boolean,
  char,
  index,
  integer,
  pgTable,
  smallint,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * 公共字段（§3）：除 `user_id` 外每张业务表都有。
 *
 * 抽成函数而不是复制字段定义：`version` 与两个时间戳的语义（乐观并发版本、
 * UTC 创建/修改时间）在每张表上必须一致，复制五遍就有五个可能漂移的版本。
 */
function commonColumns() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    /**
     * 修改时间。`$onUpdate` 让 Drizzle 的每次 `update()` 自动带上新值——
     * 交给调用方手动赋值，迟早会有某条更新路径忘记。
     */
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    /**
     * 乐观并发版本。
     *
     * **由仓储在 UPDATE 里显式写 `version + 1`**，不用默认值兜底：递增必须与
     * 「WHERE version = 期望值」在同一条语句里完成，否则"读版本—改数据—再写版本"
     * 之间存在窗口，两个并发写会同时通过检查（这正是乐观并发要防的事）。
     * 这里的 `default(1)` 只负责 INSERT 时的初值。
     */
    version: bigint('version', { mode: 'number' }).default(1).notNull(),
  };
}

/**
 * 用户表（§4.1）。
 *
 * **不设 `deleted_at`**：账户删除随 data-management 批次（含云端模式）实施，
 * 届时按「加列迁移」补（§4.1 的注解）。预先加一个永远为 null 的列，只会让
 * 后来的人以为已有软删除语义。
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 云端模式可选；本地模式为 null。唯一性对 null 不生效，因此本地单用户不受影响。 */
    email: varchar('email', { length: 320 }),
    displayName: varchar('display_name', { length: 80 }),
    /** `local` / `cloud`。本批只写入 `local`。 */
    mode: varchar('mode', { length: 16 }).notNull(),
    /** 用户设置（IAM-002）。默认值只给「服务端有权威取值」的那些列。 */
    locale: varchar('locale', { length: 16 }).default('zh-CN').notNull(),
    /** IANA 时区。无数据库默认值：初始值由用户在设置页确认（§4.1 注「默认由用户确认」）。 */
    timezone: varchar('timezone', { length: 64 }).notNull(),
    currencyCode: char('currency_code', { length: 3 }).default('CNY').notNull(),
    /** 0–6（0 = 周日）。默认 1（周一）——中文语境下周一为周首。 */
    weekStartsOn: smallint('week_starts_on').default(1).notNull(),
    reminderEnabled: boolean('reminder_enabled').default(true).notNull(),
    /** `time` 由 PG 存为无时区的一天内时刻：安静时段是"每天的几点到几点"，不是瞬时。 */
    quietHoursStart: time('quiet_hours_start'),
    quietHoursEnd: time('quiet_hours_end'),
    defaultTaskDurationMinutes: integer('default_task_duration_minutes'),
    defaultBufferMinutes: integer('default_buffer_minutes'),
    aiEnabled: boolean('ai_enabled').default(false).notNull(),
    aiDataConsent: boolean('ai_data_consent').default(false).notNull(),
    ...commonColumns(),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    index('users_mode_idx').on(table.mode),
    /**
     * 「本地模式至多一个用户」的部分唯一索引（IAM-001 的幂等硬保证）。
     *
     * 为什么不能只靠应用层的"先查后插"：`SELECT ... FOR UPDATE` **对空结果集
     * 不加任何锁**（PG 没有 gap lock），所以两个并发首启事务都会查到"没有用户"、
     * 都会插入——于是产生了两个本地用户。行锁在这里失效，唯一约束不会。
     *
     * 实现侧因此捕获唯一冲突并回退为"读取既有用户"，把并发首启变成一次幂等重试。
     * 用部分索引（`WHERE mode = 'local'`）而不是 `unique(mode)`：后者会顺带限制
     * "只能有一个 cloud 用户"，那不是任何人的意图。
     */
    uniqueIndex('users_single_local_unique')
      .on(table.mode)
      .where(sql`mode = 'local'`),
  ],
);

/**
 * 生活领域表（§4.2）。
 *
 * `color_key` 只存**语义 key**（`blue` / `green` / …），不存前端色值：色值属于
 * 设计系统（UI 规范 §2.1 的分类色族），把它写进数据行会让改配色变成一次数据迁移。
 */
export const lifeAreas = pgTable(
  'life_areas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 60 }).notNull(),
    colorKey: varchar('color_key', { length: 32 }).notNull(),
    sortOrder: integer('sort_order').notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    isArchived: boolean('is_archived').default(false).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    ...commonColumns(),
  },
  (table) => [
    index('life_areas_user_sort_idx').on(table.userId, table.sortOrder),
    // 约束「同一用户未归档领域名称唯一」（§4.2）。
    // 必须是**部分**唯一索引：`WHERE is_archived = false` 让归档项不参与唯一性，
    // 否则「归档了『健康』之后就再也不能新建同名领域」——而归档的语义恰恰是
    // 「从选择器里移开、历史仍可解析」，不该永久占住名字。
    uniqueIndex('life_areas_user_active_name_unique')
      .on(table.userId, table.name)
      .where(sql`is_archived = false`),
  ],
);

/** 表行类型，供仓储实现使用。 */
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type LifeAreaRow = typeof lifeAreas.$inferSelect;
export type NewLifeAreaRow = typeof lifeAreas.$inferInsert;
