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
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
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
    /**
     * 批 A 增列（AUTH-001，2026-10-09；《数据库设计文档》§4.1 批 A 注记）。
     *
     * `username`：档 A 登录标识 A-2。可空——本地用户恒 NULL，唯一索引对全 NULL
     * 不生效（PG 语义），存量行零影响。写入前在应用层 trim + ASCII 小写归一，
     * 于是唯一索引即「大小写不敏感」。字符集不含 `@`，与邮箱路径零重叠——
     * 登录标识「含 @ 走邮箱、否则走 username」的单一判定规则由此成立。
     */
    username: varchar('username', { length: 30 }),
    /** scrypt 编码串（`scrypt$N$r$p$salt$hash`）；本地用户恒 NULL。 */
    passwordHash: varchar('password_hash', { length: 160 }),
    /** 注册核码通过时写入、改邮箱成功时更新；云端用户恒非空（应用层不变式）。 */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
    ...commonColumns(),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    uniqueIndex('users_username_unique').on(table.username),
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
    /**
     * 云端用户必须同时具备登录标识与凭据（AUTH-001，RD-012 §2.1）。
     *
     * 存量行清一色 `mode='local'`，约束对它们零破坏；应用层注册流程单事务写入
     * email + password_hash，永远满足本约束——它防的是「绕过应用直插半成品
     * cloud 行」这类漂移，而不是正常路径。
     */
    check(
      'users_cloud_requires_credentials',
      sql`mode = 'local' OR (email IS NOT NULL AND password_hash IS NOT NULL)`,
    ),
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
    // 同步增量拉取（DB §4.18.1(4)）：keyset 扫描按 `(user_id, change_at, id)`。
    index('life_areas_user_updated_idx').on(table.userId, table.updatedAt, table.id),
    // 约束「同一用户未归档领域名称唯一」（§4.2）。
    // 必须是**部分**唯一索引：`WHERE is_archived = false` 让归档项不参与唯一性，
    // 否则「归档了『健康』之后就再也不能新建同名领域」——而归档的语义恰恰是
    // 「从选择器里移开、历史仍可解析」，不该永久占住名字。
    uniqueIndex('life_areas_user_active_name_unique')
      .on(table.userId, table.name)
      .where(sql`is_archived = false`),
  ],
);

/**
 * 目标表（§4.3）。
 *
 * `result_metric` 是「结果进度」（手动维护），与由行动状态汇总的「行动进度」
 * 分别存储、分别展示（SRS FR-023）；服务端不据 current/target 自动判定完成。
 */
export const goals = pgTable(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lifeAreaId: uuid('life_area_id').references(() => lifeAreas.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 160 }).notNull(),
    /** 理由属敏感内容：不进日志原文（接口文档 §5）。 */
    reason: text('reason'),
    /** active / completed / paused / abandoned（§4.3）。 */
    status: varchar('status', { length: 24 }).default('active').notNull(),
    /** `date` 列存日历日本身（YYYY-MM-DD），无时区语义——"目标截止到哪一天"不是瞬时。 */
    startDate: date('start_date', { mode: 'string' }),
    targetDate: date('target_date', { mode: 'string' }),
    resultMetric: jsonb('result_metric'),
    ...commonColumns(),
  },
  (table) => [
    index('goals_user_status_idx').on(table.userId, table.status),
    // 同步增量拉取（DB §4.18.1(4)）。
    index('goals_user_updated_idx').on(table.userId, table.updatedAt, table.id),
  ],
);

/**
 * 目标行动表（§4.4）。
 *
 * 行动挂在目标下；删除为软删（`deleted_at`），并在同事务把关联任务的
 * `action_id` 置空（`goal_id` 保留、任务不删）——见 GOAL-001。
 */
export const actions = pgTable(
  'actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    goalId: uuid('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 160 }).notNull(),
    minimumVersion: varchar('minimum_version', { length: 160 }),
    /** 结构由调用方给定（如 { period: 'week', count: 3 }），服务端只存不解释。 */
    targetFrequency: jsonb('target_frequency'),
    estimatedMinutes: integer('estimated_minutes'),
    /** active / completed / paused（§4.4）。 */
    status: varchar('status', { length: 24 }).default('active').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    ...commonColumns(),
  },
  (table) => [
    index('actions_user_goal_idx').on(table.userId, table.goalId),
    // 同步增量拉取（DB §4.18.1(4)）。
    index('actions_user_updated_idx').on(table.userId, table.updatedAt, table.id),
  ],
);

/**
 * 任务表（§4.5）。
 *
 * 状态流转的**唯一权威**是《数据库设计》§4.5 的完整合法流转表（含反向/重开），
 * 以 `src/modules/tasks/domain/task.ts` 里与之同源导出的矩阵在应用层判定；
 * 删除不经状态值，直接置 `deleted_at`（软删）。
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lifeAreaId: uuid('life_area_id').references(() => lifeAreas.id, { onDelete: 'set null' }),
    goalId: uuid('goal_id').references(() => goals.id, { onDelete: 'set null' }),
    actionId: uuid('action_id').references(() => actions.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 240 }).notNull(),
    /** inbox / planned / in_progress / completed / partial / deferred / skipped / archived。 */
    status: varchar('status', { length: 24 }).default('inbox').notNull(),
    estimatedMinutes: integer('estimated_minutes'),
    minimumVersion: varchar('minimum_version', { length: 160 }),
    /** `date` 列存日历日本身（YYYY-MM-DD）——"截止到哪一天"不是瞬时，时区只影响日界计算。 */
    dueDate: date('due_date', { mode: 'string' }),
    recurrenceRule: jsonb('recurrence_rule'),
    /**
     * 物化实例溯源（DB §4.5，Phase 4 起启用）：带 recurrence_rule 的行是模板，
     * 展开出的实例行指向模板。模板行自身为 NULL。
     */
    templateId: uuid('template_id').references((): AnyPgColumn => tasks.id, {
      onDelete: 'cascade',
    }),
    /** manual / ai / import / recurrence（Phase 4：物化实例）。 */
    source: varchar('source', { length: 24 }).default('manual').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    ...commonColumns(),
  },
  (table) => [
    index('tasks_user_status_updated_idx').on(table.userId, table.status, table.updatedAt),
    // 同步增量拉取的 keyset 索引（DB §4.18.1(4)，PD-20260923-004 裁定 3）：
    // `tasks_user_status_updated_idx` 第二列是 status，keyset 的 `(change_at, id)` 用不上它。
    index('tasks_user_updated_idx').on(table.userId, table.updatedAt, table.id),
    index('tasks_user_due_idx').on(table.userId, table.dueDate),
    index('tasks_user_deleted_idx').on(table.userId, table.deletedAt),
    /**
     * 实例展开的幂等硬保证（DB §4.5）：同一模板同一日历日只可能有一行实例。
     * 部分唯一——模板行（template_id 为 NULL）不参与该约束。
     */
    uniqueIndex('tasks_template_due_unique')
      .on(table.userId, table.templateId, table.dueDate)
      .where(sql`template_id is not null`),
  ],
);

/**
 * 写操作幂等识别表（§4.15）。
 *
 * 支撑接口文档 §1.1 的 `Idempotency-Key`：首次请求先占行（processing）再执行业务，
 * 完成后存响应快照；同 key 的重试**重放**首次结果（409 `IDEMPOTENCY_REPLAY`），
 * 同 key 但请求体指纹不同视为客户端错误（400）。唯一约束 `(user_id, key)` 是
 * 并发占位的硬保证——行锁对"尚不存在的行"无能为力，与 users_single_local_unique 同理。
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 128 }).notNull(),
    /** 请求体指纹（sha-256 hex）。同 key 不同指纹＝客户端把同一个键用在了不同操作上。 */
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    /** 首次成功响应的快照，重放时返回。 */
    responseSnapshot: jsonb('response_snapshot'),
    /** processing / completed（§4.15）。 */
    status: varchar('status', { length: 16 }).default('processing').notNull(),
    ...commonColumns(),
  },
  (table) => [
    uniqueIndex('idempotency_keys_user_key_unique').on(table.userId, table.key),
    index('idempotency_keys_created_idx').on(table.createdAt),
  ],
);

/**
 * 同步冲突记录表（DB §4.14，Phase 5 落地）。
 *
 * `push` 的乐观并发校验（CAS）失败时写入一行，返回给客户端由用户二选
 * （`keep_server` / `keep_local`）。它与 `idempotency_keys` 职责无重叠：
 * 前者记「冲突了什么」，后者记「这个操作是否已处理过」。
 *
 * **部分唯一索引 `sync_conflicts_pending_unique` 是 `conflictId` 稳定的硬保证**：
 * 同一实体的重复冲突不再新建行，而是命中同一行，客户端拿到的 `conflictId` 不变。
 * 已解决的行（`status <> 'pending'`）不参与唯一性，因此同一实体再次冲突时可以
 * 另起一行——这正是「历史冲突可追溯」与「当前待处理冲突唯一」两个需求的交点。
 *
 * `local_payload_json` 可空：客户端未提供本地 payload 时（例如仅版本号不匹配的
 * 探测型提交）只记版本不记内容。
 */
export const syncConflicts = pgTable(
  'sync_conflicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 实体类型（`task` / `goal` / …），取值同 pull 的 `entityType`。 */
    entityType: varchar('entity_type', { length: 32 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    /** 本地待同步版本；客户端未提供时为 NULL。 */
    localVersion: bigint('local_version', { mode: 'number' }),
    serverVersion: bigint('server_version', { mode: 'number' }).notNull(),
    /** 本地待同步 payload；客户端未提供时为 NULL。 */
    localPayloadJson: jsonb('local_payload_json'),
    /** 服务端当前 payload（用户二选时展示给对方）。 */
    serverPayloadJson: jsonb('server_payload_json').notNull(),
    /** `pending` / `resolved`。 */
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    ...commonColumns(),
  },
  (table) => [
    index('sync_conflicts_user_status_idx').on(table.userId, table.status),
    uniqueIndex('sync_conflicts_pending_unique')
      .on(table.userId, table.entityType, table.entityId)
      .where(sql`status = 'pending'`),
  ],
);

/** 表行类型，供仓储实现使用。 */
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type LifeAreaRow = typeof lifeAreas.$inferSelect;
export type NewLifeAreaRow = typeof lifeAreas.$inferInsert;
export type GoalRow = typeof goals.$inferSelect;
export type NewGoalRow = typeof goals.$inferInsert;
export type ActionRow = typeof actions.$inferSelect;
export type NewActionRow = typeof actions.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKeyRow = typeof idempotencyKeys.$inferInsert;
export type SyncConflictRow = typeof syncConflicts.$inferSelect;
export type NewSyncConflictRow = typeof syncConflicts.$inferInsert;

/* ------------------------------------------------------------------ */
/* Phase 4（DB §4.6/4.7/4.8/4.16/4.17）                                */
/* ------------------------------------------------------------------ */

/** 时间块（DB §4.6）：UTC 存储时刻 + `timezone` 列保留解释语义。 */
export const scheduleBlocks = pgTable(
  'schedule_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    actionId: uuid('action_id').references(() => actions.id, { onDelete: 'cascade' }),
    /** 例程展开溯源（DB §4.6，Phase 4 起启用）。 */
    routineId: uuid('routine_id').references(() => routines.id, { onDelete: 'cascade' }),
    routineStepId: uuid('routine_step_id').references(() => routineSteps.id, {
      onDelete: 'cascade',
    }),
    startsAtUtc: timestamp('starts_at_utc', { withTimezone: true, mode: 'date' }).notNull(),
    endsAtUtc: timestamp('ends_at_utc', { withTimezone: true, mode: 'date' }).notNull(),
    timezone: varchar('timezone', { length: 64 }).notNull(),
    /** manual / suggested / imported / routine。 */
    source: varchar('source', { length: 24 }).default('manual').notNull(),
    /** planned / active / completed / adjusted / cancelled。 */
    status: varchar('status', { length: 24 }).default('planned').notNull(),
    /** none / warning / confirmed。 */
    conflictState: varchar('conflict_state', { length: 24 }).default('none').notNull(),
    ...commonColumns(),
  },
  (table) => [
    index('schedule_blocks_user_window_idx').on(table.userId, table.startsAtUtc, table.endsAtUtc),
    // 同步增量拉取（DB §4.18.1(4)）。
    index('schedule_blocks_user_updated_idx').on(table.userId, table.updatedAt, table.id),
  ],
);

/** 例程定义（DB §4.7）：recurrence_rule 结构同 tasks（§4.5 最小规则）。 */
export const routines = pgTable(
  'routines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lifeAreaId: uuid('life_area_id').references(() => lifeAreas.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 160 }).notNull(),
    recurrenceRule: jsonb('recurrence_rule').notNull(),
    /** `HH:MM` 本地锚点；安排例程时各步顺序展开的默认起点。 */
    anchorTime: varchar('anchor_time', { length: 5 }),
    timezone: varchar('timezone', { length: 64 }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    ...commonColumns(),
  },
  (table) => [
    // 同步增量拉取（DB §4.18.1(4)）。
    index('routines_user_updated_idx').on(table.userId, table.updatedAt, table.id),
  ],
);

/** 例程步骤（DB §4.7）：`(routine_id, position)` 唯一且从 0 连续。 */
export const routineSteps = pgTable(
  'routine_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    routineId: uuid('routine_id')
      .notNull()
      .references(() => routines.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 240 }).notNull(),
    position: integer('position').notNull(),
    estimatedMinutes: integer('estimated_minutes'),
    minimumVersion: varchar('minimum_version', { length: 160 }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    ...commonColumns(),
  },
  (table) => [
    /**
     * 活跃步骤的位置唯一（DB §4.7「(routine_id, position) 唯一且从 0 连续」）。
     *
     * **部分索引（`WHERE deleted_at IS NULL`，批 1 迁移 0009 由全局索引改来）**：
     * 软删语义要求唯一性只约束「在用行」——全局唯一会让一条已软删步骤**永久
     * 占住它的位置**，导入 replace（契约 §13：先软删既有、再写入文件）与任何
     * 「删一步再补一步」的编辑都会被墓碑行挡住。同一模式已在仓库内有先例：
     * `life_areas_user_active_name_unique`（归档项不占名）与
     * `tasks_template_due_unique`（模板行才参与）。索引名不变——只放宽、不收紧，
     * 既有数据与既有约束断言零影响。
     */
    uniqueIndex('routine_steps_position_unique')
      .on(table.routineId, table.position)
      .where(sql`deleted_at is null`),
    // 同步增量拉取（DB §4.18.1(4)）。
    index('routine_steps_user_updated_idx').on(table.userId, table.updatedAt, table.id),
  ],
);

/**
 * 执行记录（DB §4.8）：**追加式**——无 version、无更新端点，重复提交靠
 * Idempotency-Key（§7）；历史快照语义（名称/时长随后续改名不失真）由
 * 各列在写入时刻的取值承载。
 */
export const executionLogs = pgTable(
  'execution_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    actionId: uuid('action_id').references(() => actions.id, { onDelete: 'set null' }),
    scheduleBlockId: uuid('schedule_block_id').references(() => scheduleBlocks.id, {
      onDelete: 'set null',
    }),
    /** completed / minimum_completed / partial / deferred / skipped。 */
    status: varchar('status', { length: 24 }).notNull(),
    plannedMinutes: integer('planned_minutes'),
    actualMinutes: integer('actual_minutes'),
    reasonCode: varchar('reason_code', { length: 40 }),
    note: text('note'),
    /** low / medium / high。 */
    energyLevel: varchar('energy_level', { length: 16 }),
    moodScore: smallint('mood_score'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('execution_logs_user_time_idx').on(table.userId, table.occurredAt),
    index('execution_logs_user_task_time_idx').on(table.userId, table.taskId, table.occurredAt),
    // 同步增量拉取（DB §4.18.1(4)）：追加式表无 `updated_at`，以 `created_at` 为变更时刻。
    index('execution_logs_user_created_idx').on(table.userId, table.createdAt, table.id),
  ],
);

/**
 * 固定事项（DB §4.16）：单次事项 / 重复模板 / 重复实例三形态——
 * `recurrence_rule` 非空即模板，`template_id` 非空即实例。
 */
export const fixedCommitments = pgTable(
  'fixed_commitments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 240 }).notNull(),
    templateId: uuid('template_id').references((): AnyPgColumn => fixedCommitments.id, {
      onDelete: 'cascade',
    }),
    /** 实例行的归属日历日；模板行 NULL。 */
    localDate: date('local_date', { mode: 'string' }),
    startsAtUtc: timestamp('starts_at_utc', { withTimezone: true, mode: 'date' }),
    endsAtUtc: timestamp('ends_at_utc', { withTimezone: true, mode: 'date' }),
    /** `HH:MM` 本地钟点；仅模板行有。 */
    startsAtLocal: varchar('starts_at_local', { length: 5 }),
    durationMinutes: integer('duration_minutes').notNull(),
    timezone: varchar('timezone', { length: 64 }).notNull(),
    recurrenceRule: jsonb('recurrence_rule'),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    ...commonColumns(),
  },
  (table) => [
    index('fixed_commitments_user_date_idx').on(table.userId, table.localDate),
    index('fixed_commitments_user_window_idx').on(table.userId, table.startsAtUtc, table.endsAtUtc),
    // 同步增量拉取（DB §4.18.1(4)）。
    index('fixed_commitments_user_updated_idx').on(table.userId, table.updatedAt, table.id),
    uniqueIndex('fixed_commitments_template_date_unique')
      .on(table.userId, table.templateId, table.localDate)
      .where(sql`template_id is not null`),
  ],
);

/** 恢复模式手动态（DB §4.17）：每用户一行，upsert 即并发口径。 */
export const recoveryStates = pgTable('recovery_states', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull(),
  since: timestamp('since', { withTimezone: true, mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

/* ------------------------------------------------------------------ */
/* Phase 6+7（DB §4.9 / §4.10 / §4.11）                                */
/* ------------------------------------------------------------------ */

/**
 * 支出分类（DB §4.9，Phase 6 落地）。
 *
 * `sort_order` 是 §4.9 于 2026-09-28 补入的列（RD-20260928-004 §五披露 E）：FR-051
 * 要求 9 个默认分类按固定顺序展示、新分类追加末位——缺列则顺序不可稳定复现。
 *
 * **不设 `deleted_at`**：停用＝置 `is_archived`（FR-051「停用不删历史」），本批无
 * 删除入口。不留无写入路径的死列——这是预审裁定 C.4 采 B 的直接结论，也是 Phase 5
 * `life_areas` 那列为 NULL 的教训。
 */
export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 60 }).notNull(),
    sortOrder: integer('sort_order').notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    isArchived: boolean('is_archived').default(false).notNull(),
    ...commonColumns(),
  },
  (table) => [
    index('expense_categories_user_sort_idx').on(table.userId, table.sortOrder),
    // 约束「同一用户未停用分类名称唯一」（§4.9）：部分唯一，停用项不占名字。
    uniqueIndex('expense_categories_user_active_name_unique')
      .on(table.userId, table.name)
      .where(sql`is_archived = false`),
  ],
);

/**
 * 开销（DB §4.10，Phase 6 落地）。
 *
 * **金额取 `bigint` 的 `bigint` 驱动模式**，而不是既有 `version` 用的 `number` 模式：
 * `number` 模式在回读时经 `Number()` 转换，超过 2^53 的金额会丢精度——那正是「零浮点
 * 金额」铁律要防的事。域对象、DTO、同步 payload 一律用**字符串**承载金额，仓储在
 * 边界上做 `bigint ↔ string` 转换，任何环节都不得出现 `Number()`。
 *
 * `goal_id` 与 `action_id` **两列独立可空、可同时有值**（RD-20260928-004 §四披露 D）：
 * 选中行动时同时落父目标；`groupBy=goal` 因此是单列过滤、无需 JOIN `actions`，
 * 与 `tasks` 两列并存的口径一致。
 */
export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * 分类为 NOT NULL，故不能 `set null`。选 `restrict`：分类只有停用、没有删除
     * 入口，该约束当前零成本；真出现删除路径时它会**报错**（fail-loud），而不是
     * 静默带走历史开销。
     */
    categoryId: uuid('category_id')
      .notNull()
      .references(() => expenseCategories.id, { onDelete: 'restrict' }),
    lifeAreaId: uuid('life_area_id').references(() => lifeAreas.id, { onDelete: 'set null' }),
    goalId: uuid('goal_id').references(() => goals.id, { onDelete: 'set null' }),
    actionId: uuid('action_id').references(() => actions.id, { onDelete: 'set null' }),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    /** `date` 列存日历日本身（YYYY-MM-DD）——「这笔记在哪一天」不是瞬时。 */
    occurredOn: date('occurred_on', { mode: 'string' }).notNull(),
    paymentMethod: varchar('payment_method', { length: 40 }),
    /** 备注按敏感内容对待：不进普通日志（接口文档 §9）。 */
    note: text('note'),
    /** manual / ai_draft / import。 */
    source: varchar('source', { length: 24 }).default('manual').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    ...commonColumns(),
  },
  (table) => [
    index('expenses_user_occurred_idx').on(table.userId, table.occurredOn),
    index('expenses_user_category_occurred_idx').on(
      table.userId,
      table.categoryId,
      table.occurredOn,
    ),
    index('expenses_user_goal_idx').on(table.userId, table.goalId),
    // 同步增量拉取（DB §4.18.4）：§4.10 原文三索引均不含 updated_at，支撑不了
    // `(changeAt, id)` keyset 扫描——缺此则 pull 退化为全表扫描。
    index('expenses_user_updated_idx').on(table.userId, table.updatedAt, table.id),
  ],
);

/**
 * 复盘（DB §4.11.1，Phase 7 落地）。
 *
 * `(user_id, review_type, period_key)` 是**普通唯一索引**：它同时是日/周复盘的
 * upsert 键、以及「离线创建日复盘」的去重键（披露 B.2 甲案——客户端生成 uuid，
 * 同日在线再 PUT 时命中同一行，不重复建行）。
 *
 * **不设 `deleted_at`**：本批无删除入口（「跳过今天」是纯前端行为、不落记录），
 * 故归入同步链路的**无删除语义**类，`deleted` 恒 `false`（DB §4.18.4）。
 */
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** daily / weekly。 */
    reviewType: varchar('review_type', { length: 8 }).notNull(),
    /** daily = 用户时区下的 `YYYY-MM-DD`；weekly = 该周周一的 `YYYY-MM-DD`。 */
    periodKey: varchar('period_key', { length: 10 }).notNull(),
    /** 日复盘三问（键可缺省）；周复盘为 null。 */
    answers: jsonb('answers'),
    /** low / medium / high。 */
    energyLevel: varchar('energy_level', { length: 8 }),
    /** 周复盘结构化快照（§4.11.3）；日复盘为 null。 */
    snapshot: jsonb('snapshot'),
    /** 与 `snapshot` 同生共死；当前为 1（§4.11.2 的演进保障）。 */
    snapshotSchemaVersion: integer('snapshot_schema_version'),
    ...commonColumns(),
  },
  (table) => [
    uniqueIndex('reviews_user_type_period_unique').on(
      table.userId,
      table.reviewType,
      table.periodKey,
    ),
    // 同步增量拉取（DB §4.18.4）。
    index('reviews_user_updated_idx').on(table.userId, table.updatedAt, table.id),
  ],
);

/**
 * 复盘调整（DB §4.11.4，Phase 7 落地）：**追加式**。
 *
 * 无 `version`、无 `deleted_at`——B4 冻结「清单只增不删、本页不提供撤销」，没有
 * 更新与删除路径；且不参与同步（拍板 1 仅 `expense` / `review` 两实体）。因此这里
 * 不复用 `commonColumns()`（它会带上用不到的 `version`），而是像 `recovery_states`
 * 一样只取两个时间戳。
 *
 * `target_id` **不设外键**：它按 `target_type` 指向 `tasks` 或 `goals`，是多态引用，
 * 单一 FK 表达不了（DB §4.11.4 亦未定义 FK）。
 */
export const reviewAdjustments = pgTable(
  'review_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    /** task / goal。 */
    targetType: varchar('target_type', { length: 16 }).notNull(),
    targetId: uuid('target_id').notNull(),
    /** keep / shorten / defer / pause / delete（五动作，§4.11.4）。 */
    action: varchar('action', { length: 24 }).notNull(),
    payload: jsonb('payload').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    /** 插入后无写入路径：Drizzle 的 `$onUpdate` 在这里不会被触发。 */
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('review_adjustments_user_review_created_idx').on(
      table.userId,
      table.reviewId,
      table.createdAt,
    ),
  ],
);

/**
 * 提醒规则（DB §4.12.1，Phase 8 落地 / NOTIFY-001）。
 *
 * `level` 是**服务端派生、只读**列（`task→normal` / `routine→critical` / `review→review`）：
 * 它有服务端写入路径（创建时按 `target_type` 计算落库），因此不属于"无写入路径的死列"，
 * 而是可支撑按等级排序与 `deliveries.level` 快照同名的物化列。
 *
 * **不设 `version` / `deleted_at`**：本批不入同步白名单（拍板 2），无跨端 CAS 与墓碑需求；
 * `DELETE` 入口走**硬删**（§4.12.1）。因此这里不复用 `commonColumns()`。
 */
export const notificationRules = pgTable(
  'notification_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** task / routine / review。 */
    targetType: varchar('target_type', { length: 16 }).notNull(),
    /** task/routine 必填；review 必须为 NULL（不绑定实体，由 CHECK 兜底）。 */
    targetId: uuid('target_id'),
    /** 用户时区下的本地时刻 `HH:MM:SS`——与 `users.quiet_hours_start` 同类型。 */
    remindAt: time('remind_at').notNull(),
    /** none / daily / weekly。 */
    repeatRule: varchar('repeat_rule', { length: 16 }).default('none').notNull(),
    /** 默认 false：不勾＝安静时段内抑制，而非豁免。 */
    allowQuietHours: boolean('allow_quiet_hours').default(false).notNull(),
    /** 单条关闭＝false（FR-070 第 4 项）；不提供删除按钮。 */
    enabled: boolean('enabled').default(true).notNull(),
    /** critical / normal / review，服务端按 `target_type` 派生。 */
    level: varchar('level', { length: 16 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    /** 行更新经 `update()`，`$onUpdate` 自动前移；此处不写 `$onUpdate` 会漏掉硬删以外的所有写路径。 */
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('notification_rules_user_target_idx').on(table.userId, table.targetType, table.targetId),
    index('notification_rules_user_enabled_remind_idx').on(
      table.userId,
      table.enabled,
      table.remindAt,
    ),
    check(
      'notification_rules_review_target_null_check',
      sql`${table.targetType} <> 'review' OR ${table.targetId} IS NULL`,
    ),
  ],
);

/**
 * 提醒交付记录（DB §4.12.2，Phase 8 落地 / NOTIFY-002）。
 *
 * ## 三条贯穿全表的语义
 *
 * - **`status` 严守四值**（`pending`/`sent`/`failed`/`cancelled`）：用户「已处理」只写
 *   `dismissed_at`、**不改 status**，从而不扩枚举（§4.12.2）。
 * - **`error_code` 在 `status='failed'` 时必填**（CHECK 兜底）——"发送失败必须记录错误码"
 *   的可执行表达，而不是一句注释。
 * - **`channel` 是纯服务端派生字段**：物化时 `in_app`；`attempt` 上报落痕时（无论成败）
 *   置 `browser`——使渠道枚举的 `browser` 值获得唯一写入路径，不留死值。
 *
 * **不设 `version` / `deleted_at`**（不入同步白名单，拍板 2）。
 * `rule_id` 用 `ON DELETE SET NULL`：规则硬删后**保留历史留痕**（§4.12.2）。
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id').references(() => notificationRules.id, { onDelete: 'set null' }),
    /** task / routine / review，冗余自规则：规则删除后仍可解释本条语义。 */
    targetType: varchar('target_type', { length: 16 }).notNull(),
    targetId: uuid('target_id'),
    /** in_app / browser（云端渠道留位，拍板 2）。 */
    channel: varchar('channel', { length: 16 }).default('in_app').notNull(),
    /** 触达时的实际等级**快照**，不随规则后续变更。 */
    level: varchar('level', { length: 16 }).notNull(),
    /** pending / sent / failed / cancelled。 */
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    /** 本次触达目标时刻（UTC 瞬时）。 */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }).notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' }),
    /** failed 时必填（CHECK 兜底）；取值限 §4.12.2 四值，与 §1.4 API 错误码不同源。 */
    errorCode: varchar('error_code', { length: 48 }),
    /** 仅「可重试失败」非空；NULL 表示不再重试。 */
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true, mode: 'date' }),
    /** 应用内面板的「已处理」出口：写它、不改 status。 */
    dismissedAt: timestamp('dismissed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('notification_deliveries_user_status_scheduled_idx').on(
      table.userId,
      table.status,
      table.scheduledFor,
    ),
    index('notification_deliveries_user_scheduled_idx').on(table.userId, table.scheduledFor),
    // 部分索引：只索引「可重试失败」行，避免重试扫描退化为全表。
    index('notification_deliveries_user_next_retry_idx')
      .on(table.userId, table.nextRetryAt)
      .where(sql`status = 'failed'`),
    check(
      'notification_deliveries_failed_error_code_check',
      sql`${table.status} <> 'failed' OR ${table.errorCode} IS NOT NULL`,
    ),
  ],
);

/**
 * AI 草稿（DB §4.13.1，Phase 9 落地 / AI-003）。
 *
 * ## 三条 CHECK 都是「契约的可执行表达」
 *
 * - **`status <> 'failed' ⇒ result_json IS NOT NULL`**：`pending` / 已确认 / 已取消 /
 *   已过期的草稿必然携带结构化结果，"没有结果却处于可用态"是缺陷而不是合法状态；
 * - `status='failed' ⇒ error_code IS NOT NULL`：失败必须留下原因（FR-084「记错误不记内容」），
 *   这条约束与「不落 prompt 原文」是一体两面——留痕的是**原因码**，不是内容；
 * - `draft_type` 四值 `IN`：枚举漂移在写入那一刻就被数据库挡住，而不是等到读出来才由应用层报错。
 *
 * `status` 未加 `IN` 约束：§4.13.1 的约束清单未列它，既有表体例（§4.12）也不对
 * `status` 加 `IN` 约束，故保持一致；五值的把关落在领域层。
 *
 * **不设 `version` / `deleted_at`**：本批不入同步白名单（RD-20260929-009 裁定 5），
 * 无跨端 CAS 与墓碑需求。索引均不加唯一约束——同输入去重「仅作查询加速」（§4.13.1）。
 */
export const aiDrafts = pgTable(
  'ai_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 四值：task_breakdown / schedule_suggestion / expense_parse / review_summary。 */
    draftType: varchar('draft_type', { length: 24 }).notNull(),
    /** **脱敏前**输入的哈希（仅用于去重与追溯，原文不落库）。 */
    inputHash: varchar('input_hash', { length: 64 }).notNull(),
    /** **脱敏后**的输入。 */
    sanitizedInput: text('sanitized_input').notNull(),
    /** 结构化草稿；`status='failed'` 时允许为 NULL。 */
    resultJson: jsonb('result_json'),
    /** 五值：pending / confirmed / cancelled / expired / failed。 */
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    /** `mock` 或真实 provider 名。 */
    provider: varchar('provider', { length: 32 }).notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    /** 过期后对草稿 confirm 返 `CONFLICT`(409)。 */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** `status='failed'` 时必填（CHECK 兜底）；取值限 §4.13.1 五值，与 §1.4 API 错误码不同源。 */
    errorCode: varchar('error_code', { length: 48 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('ai_drafts_user_status_created_idx').on(table.userId, table.status, table.createdAt),
    index('ai_drafts_user_expires_idx').on(table.userId, table.expiresAt),
    index('ai_drafts_user_input_hash_created_idx').on(
      table.userId,
      table.inputHash,
      table.createdAt,
    ),
    check(
      'ai_drafts_result_json_check',
      sql`${table.status} = 'failed' OR ${table.resultJson} IS NOT NULL`,
    ),
    check(
      'ai_drafts_failed_error_code_check',
      sql`${table.status} <> 'failed' OR ${table.errorCode} IS NOT NULL`,
    ),
    check(
      'ai_drafts_draft_type_check',
      sql`${table.draftType} IN ('task_breakdown', 'schedule_suggestion', 'expense_parse', 'review_summary')`,
    ),
  ],
);

/**
 * AI 用量账本（DB §4.13.2，Phase 9 落地 / AI-003）。
 *
 * ## 追加式账本
 *
 * 只写不改：**不设 `updated_at` / `version` / `deleted_at`**（§4.13.2 明文）。
 * 因此这里不复用 `commonColumns()`——那两个时间戳与乐观并发版本对一条「已发生的事实」
 * 没有语义，加了只会让人以为可以改账。
 *
 * ## `status='skipped'` 是 mock 的落点
 *
 * mock 不占额度、记 `skipped`——否则本地开发与 CI 会耗尽真实额度口径（§4.13.2）。
 * **不存 prompt、不存模型原始输入输出**（本节末句与接口 §11「不返回敏感 prompt」对齐）。
 */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    /** 取值域同 `draft_type` 四值。 */
    requestType: varchar('request_type', { length: 24 }).notNull(),
    /** 供应商未提供时 NULL，不以 0 冒充。 */
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** 整数分；无报价时为 0（追加式账本不接受 NULL，口径见 §4.13.2）。 */
    estimatedCostMinor: integer('estimated_cost_minor').default(0).notNull(),
    /** success / failed / skipped。 */
    status: varchar('status', { length: 16 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [index('ai_usage_user_created_idx').on(table.userId, table.createdAt)],
);

export type AiDraftRow = typeof aiDrafts.$inferSelect;
export type NewAiDraftRow = typeof aiDrafts.$inferInsert;
export type AiUsageRow = typeof aiUsage.$inferSelect;
export type NewAiUsageRow = typeof aiUsage.$inferInsert;

/**
 * 认证部署的可吊销会话表（AUTH-001，《数据库设计文档》§4.19；RD-012 §2.2）。
 *
 * 甲案三要件（可吊销 + 多设备 + 设备标签）的落点。本地部署不写入本表——
 * 本地会话仍为无状态 HMAC Cookie（详设 §8.1）。**不设 `version`/`deleted_at`/
 * `token_hash`**：不入同步白名单、无 CAS 与墓碑需求，令牌完整性由 HMAC 签名
 * 承担（选型论证见 RD-012 §2.3——签名令牌 + sessions 行 vs 不透明令牌 + token_hash，
 * 终审裁定取前者），不留无写入路径的死列（对齐 §4.12.1 取舍）。
 */
export const sessions = pgTable(
  'sessions',
  {
    /** sessionId，签入令牌载荷（令牌＝HMAC 签名，载荷含 userId/sessionId/issuedAt/exp）。 */
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 登录时取 User-Agent 截断 + 去控制字符落存；不做 UA 解析库（零依赖）。 */
    deviceLabel: varchar('device_label', { length: 120 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    /** 更新节流 ≥5 分钟（防每请求写放大）。 */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    /** 签发＝now+30 天；半衰点（剩余 <15 天）滑动续期至 now+30 天。 */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** 吊销＝置值（登出/改密/重置/改邮箱/账户删除）；非空即失效，行状态为权威。 */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    index('sessions_expiry_idx').on(table.expiresAt),
  ],
);

/**
 * 邮箱验证码存储（AUTH-001，《数据库设计文档》§4.20；RD-012 §2.4）。
 *
 * 挂账 5「邮件/验证码通道」解锁落点：6 位 / 10 分钟 / 错 5 次作废 / 每邮箱限流 /
 * 统一文案防枚举（终审确认口径）。`code_hash` 为 HMAC-SHA256（AUTH_SECRET 分域
 * 派生，消息＝`purpose|email|code`）——**不存明文**，库泄露 ≠ 码泄露。
 * 跨 purpose 不可用；单活跃码（同 (email,purpose) 新发即同事务置旧码 consumed_at）。
 */
export const emailVerificationCodes = pgTable(
  'email_verification_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 归一小写。register 时用户尚不存在，故按 email 归属、不设 user_id。 */
    email: varchar('email', { length: 320 }).notNull(),
    /** register / login / password_reset / change_email。 */
    purpose: varchar('purpose', { length: 16 }).notNull(),
    codeHash: char('code_hash', { length: 64 }).notNull(),
    /** ≥5 作废（每次错验 +1，同码累计）。 */
    attempts: smallint('attempts').default(0).notNull(),
    /** created_at + 10 分钟。 */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** 验证成功/作废/被新码取代即置值；一次性。 */
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    /** 频控窗口计数依据。 */
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    // 每邮箱限流计数 + 单活跃码定位。
    index('email_verification_codes_email_purpose_created_idx').on(
      table.email,
      table.purpose,
      table.createdAt,
    ),
  ],
);

/**
 * 账户删除请求（OPS-002，接口 §13 删除面；批 1 迁移 0009）。
 *
 * 三态一行记全：发起（`requested_at`）→ 撤销（`cancelled_at`，7 天窗口内）
 * 或到期清理（`purged_at`，由 `scripts/` 层的到期清理脚本写入——cron 面接线
 * 归批 3 OPS-006）。`purge_at = requested_at + 7 天`（契约冻结八定值：撤销窗 7 天）。
 *
 * **一行只代表一次请求**：活跃期间重复发起返回既有行（幂等，不叠新行）；
 * 撤销后再发起会新建行。不设 `version`——本表只由单用户自己的请求推进，
 * 无跨端 CAS 需求（同 §4.13 精简理由）。
 */
export const deletionRequests = pgTable(
  'deletion_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 发起时刻；撤销窗与到期判定的基准。 */
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** `requested_at + 7 天`（契约冻结值）；到期由清理脚本执行物理删除。 */
    purgeAt: timestamp('purge_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** 窗口内撤销即置值（非空＝该请求已失效）。 */
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    /** 清理脚本完成物理删除后置值（非空＝已执行）。 */
    purgedAt: timestamp('purged_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    // 活跃请求定位与到期扫描（脚本按 purge_at 扫，小表全扫可接受）。
    index('deletion_requests_user_idx').on(table.userId, table.purgeAt),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type EmailVerificationCodeRow = typeof emailVerificationCodes.$inferSelect;
export type NewEmailVerificationCodeRow = typeof emailVerificationCodes.$inferInsert;
export type DeletionRequestRow = typeof deletionRequests.$inferSelect;
export type NewDeletionRequestRow = typeof deletionRequests.$inferInsert;

export type ScheduleBlockRow = typeof scheduleBlocks.$inferSelect;
export type NewScheduleBlockRow = typeof scheduleBlocks.$inferInsert;
export type RoutineRow = typeof routines.$inferSelect;
export type RoutineStepRow = typeof routineSteps.$inferSelect;
export type ExecutionLogRow = typeof executionLogs.$inferSelect;
export type FixedCommitmentRow = typeof fixedCommitments.$inferSelect;
export type RecoveryStateRow = typeof recoveryStates.$inferSelect;
export type ExpenseCategoryRow = typeof expenseCategories.$inferSelect;
export type NewExpenseCategoryRow = typeof expenseCategories.$inferInsert;
export type ExpenseRow = typeof expenses.$inferSelect;
export type NewExpenseRow = typeof expenses.$inferInsert;
export type ReviewRow = typeof reviews.$inferSelect;
export type NewReviewRow = typeof reviews.$inferInsert;
export type ReviewAdjustmentRow = typeof reviewAdjustments.$inferSelect;
export type NewReviewAdjustmentRow = typeof reviewAdjustments.$inferInsert;
export type NotificationRuleRow = typeof notificationRules.$inferSelect;
export type NewNotificationRuleRow = typeof notificationRules.$inferInsert;
export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;
export type NewNotificationDeliveryRow = typeof notificationDeliveries.$inferInsert;
