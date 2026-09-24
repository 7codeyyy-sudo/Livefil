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
    uniqueIndex('routine_steps_position_unique').on(table.routineId, table.position),
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

export type ScheduleBlockRow = typeof scheduleBlocks.$inferSelect;
export type NewScheduleBlockRow = typeof scheduleBlocks.$inferInsert;
export type RoutineRow = typeof routines.$inferSelect;
export type RoutineStepRow = typeof routineSteps.$inferSelect;
export type ExecutionLogRow = typeof executionLogs.$inferSelect;
export type FixedCommitmentRow = typeof fixedCommitments.$inferSelect;
export type RecoveryStateRow = typeof recoveryStates.$inferSelect;
