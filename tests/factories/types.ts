/**
 * 测试数据工厂的共享类型（FND-003）。
 *
 * 字段严格对齐《数据库设计文档》§3（公共字段规范）与 §4（核心表），
 * 一律使用数据库侧的 snake_case 命名：工厂产出的是**待写入数据库的行**，
 * 而不是领域对象或 UI 模型。领域模型建立后（FND-004 起），
 * 行到领域对象的映射应发生在映射层，而不是让测试数据迁就界面命名。
 *
 * 两处刻意的类型选择：
 * - 时间列（`timestamptz` / `date`）用 UTC ISO 字符串而非 `Date`。
 *   字符串让断言不受运行环境本地时区影响，也和 JSON 传输形态一致。
 * - 金额用 `number`。测试数据取值远低于 `Number.MAX_SAFE_INTEGER`，不会失精度；
 *   生产代码必须用整数分 + 大整数/Decimal（见该文档 §5.2），本文件的类型不构成对它的放宽。
 */
import type { Clock } from './clock.ts';
import type { IdFactory } from './ids.ts';
import type { RandomSource } from './random.ts';

/**
 * 工厂共享上下文。
 *
 * 把随机源、ID 与时钟显式注入每个工厂，而不是让工厂各自创建：
 * 同一组工厂必须共享同一条随机序列与同一个时钟，
 * 否则同一次测试里不同实体之间的时间戳与 ID 序列会互相矛盾，且无法整体复现。
 */
export interface FactoryContext {
  readonly random: RandomSource;
  readonly ids: IdFactory;
  readonly clock: Clock;
}

/** §3 公共字段。适用于带乐观并发与软删除的表。 */
export interface CommonRowFields {
  readonly id: string;
  readonly user_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
  readonly version: number;
}

// ── §4.1 users ────────────────────────────────────────────────────────────────

/** 数据模式：本地单用户，或邀请制云端账号。 */
export type UserMode = 'local' | 'cloud';

/**
 * `users` 行。
 * 注意该表**没有** `version` 与 `deleted_at` 列，因此不继承 {@link CommonRowFields}。
 */
export interface UserRow {
  readonly id: string;
  /** 云端模式可选且唯一；本地模式通常为 null。 */
  readonly email: string | null;
  readonly display_name: string | null;
  readonly mode: UserMode;
  readonly locale: string;
  readonly timezone: string;
  readonly currency_code: string;
  /** 周起始日，0 = 周日，6 = 周六。 */
  readonly week_starts_on: number;
  readonly reminder_enabled: boolean;
  readonly quiet_hours_start: string | null;
  readonly quiet_hours_end: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

// ── §4.2 life_areas ───────────────────────────────────────────────────────────

/** `life_areas` 行。 */
export interface LifeAreaRow extends CommonRowFields {
  readonly name: string;
  /** 语义色 key，不保存前端色值。 */
  readonly color_key: string;
  readonly sort_order: number;
  readonly is_default: boolean;
  readonly is_archived: boolean;
}

// ── §4.3 goals ────────────────────────────────────────────────────────────────

/** 目标状态。 */
export type GoalStatus = 'active' | 'completed' | 'paused' | 'abandoned';

/** `goals` 行。`life_area_id` 为非空外键。 */
export interface GoalRow extends CommonRowFields {
  readonly life_area_id: string;
  readonly name: string;
  readonly reason: string | null;
  readonly status: GoalStatus;
  readonly start_date: string | null;
  readonly target_date: string | null;
  /** 结构化结果指标；内容由上层校验，工厂只保证是对象或 null。 */
  readonly result_metric: Readonly<Record<string, unknown>> | null;
}

// ── §4.5 tasks ────────────────────────────────────────────────────────────────

/** 任务状态，含收件箱与「部分完成 / 延期 / 跳过」等执行结果态。 */
export type TaskStatus =
  | 'inbox'
  | 'planned'
  | 'in_progress'
  | 'completed'
  | 'partial'
  | 'deferred'
  | 'skipped'
  | 'archived';

/** 任务来源。 */
export type TaskSource = 'manual' | 'ai' | 'import';

/** `tasks` 行。三个归属外键均可空。 */
export interface TaskRow extends CommonRowFields {
  readonly life_area_id: string | null;
  readonly goal_id: string | null;
  readonly action_id: string | null;
  readonly title: string;
  readonly status: TaskStatus;
  readonly estimated_minutes: number | null;
  /** 最低可接受版本（例如「只做 5 分钟」），用于恢复模式。 */
  readonly minimum_version: string | null;
  readonly due_date: string | null;
  readonly recurrence_rule: Readonly<Record<string, unknown>> | null;
  readonly source: TaskSource;
}

// ── §4.6 schedule_blocks ──────────────────────────────────────────────────────

/** 时间块来源。 */
export type ScheduleBlockSource = 'manual' | 'suggested' | 'imported';

/** 时间块状态。 */
export type ScheduleBlockStatus = 'planned' | 'active' | 'completed' | 'adjusted' | 'cancelled';

/** 时间块冲突状态。 */
export type ConflictState = 'none' | 'warning' | 'confirmed';

/** `schedule_blocks` 行。约束：`ends_at_utc > starts_at_utc`。 */
export interface ScheduleBlockRow extends CommonRowFields {
  readonly task_id: string | null;
  readonly action_id: string | null;
  readonly starts_at_utc: string;
  readonly ends_at_utc: string;
  /** 排程时所用时区；与 UTC 时间同时保存以保留时区语义。 */
  readonly timezone: string;
  readonly source: ScheduleBlockSource;
  readonly status: ScheduleBlockStatus;
  readonly conflict_state: ConflictState;
}

// ── §4.9 expense_categories ───────────────────────────────────────────────────

/** `expense_categories` 行。 */
export interface ExpenseCategoryRow extends CommonRowFields {
  readonly name: string;
  readonly is_default: boolean;
  readonly is_archived: boolean;
}

// ── §4.10 expenses ────────────────────────────────────────────────────────────

/** 开销来源。 */
export type ExpenseSource = 'manual' | 'ai_draft' | 'import';

/** `expenses` 行。`category_id` 为非空外键；`amount_minor` 恒为正整数分。 */
export interface ExpenseRow extends CommonRowFields {
  readonly category_id: string;
  readonly life_area_id: string | null;
  readonly goal_id: string | null;
  readonly action_id: string | null;
  /** 最小货币单位的整数金额（如人民币的「分」）。 */
  readonly amount_minor: number;
  /** ISO 4217 三字母币种代码。 */
  readonly currency_code: string;
  readonly occurred_on: string;
  readonly payment_method: string | null;
  readonly note: string | null;
  readonly source: ExpenseSource;
}

// ── §4.11 reviews ─────────────────────────────────────────────────────────────

/** 复盘周期。 */
export type ReviewPeriod = 'daily' | 'weekly';

/**
 * `reviews` 行。
 *
 * 《数据库设计文档》§4.11 目前只有文字说明、**尚无字段清单**，因此这里只保留
 * 文档已明确表达的三点：复盘周期、结构化快照、以及快照必须携带的 schema 版本
 * （文档要求「不能依赖未来实时重新计算才能展示历史」）。
 *
 * 该表字段补全前，本类型与 `reviewFactory` 都只是骨架。
 * 待办已记入《开发任务清单》REVIEW-001。
 */
export interface ReviewRow extends CommonRowFields {
  readonly period: ReviewPeriod;
  /** 周期起始日（`date`）。 */
  readonly period_start: string;
  readonly snapshot: Readonly<Record<string, unknown>> | null;
  readonly snapshot_schema_version: number;
}
