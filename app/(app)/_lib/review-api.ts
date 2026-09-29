/**
 * 复盘域的接口封装与周历运算（REVIEW-001~003，《接口文档》§10）。
 *
 * ## 为什么周历运算也在这里
 *
 * 「本周是哪一周」在两处要用（周复盘的 `weekStart` 路径参数、页面显示的范围），
 * 而且它必须与**用户设置**的 `weekStartsOn` 一致。放在这里与取数同源，页面就不必
 * 各自实现一遍日期加减（各实现一遍的典型后果是：一处按周一起算、一处按周日起算，
 * 于是「本周」在标题和请求里指向不同的七天）。
 *
 * 全部用**纯字符串 + UTC 锚点**做日历运算：`YYYY-MM-DD` 是日历日、不带时区，
 * 用本地 `Date` 的时区去加减会在夏令时边界上漂一天。
 */
import { fetchJson, sendJson } from './api-client';
import type { ApiEnvelope } from './api-client';

/** 精力三档（接口 §10 的枚举全集）。 */
export const ENERGY_LEVELS = ['low', 'medium', 'high'] as const;

export type EnergyLevel = (typeof ENERGY_LEVELS)[number];

/** 三问的键与顺序（FR-060；顺序即 B1 三卡的纵向顺序）。 */
export const REVIEW_ANSWER_KEYS = ['completed', 'blocker', 'nextAdjustment'] as const;

export type ReviewAnswerKey = (typeof REVIEW_ANSWER_KEYS)[number];

/** 三问的答案（键可缺省＝未答；空串在提交前丢掉，不会出现"有键值为空"）。 */
export type ReviewAnswers = Partial<Record<ReviewAnswerKey, string>>;

/** 日复盘的事实摘要（接口 §10）。 */
export interface DailyFacts {
  readonly plannedMinutes: number;
  readonly actualMinutes: number;
  readonly completedCount: number;
  readonly uncompletedCount: number;
}

/** `GET /reviews/daily/{date}` 的 `data`（未创建时整个 `data` 为 `null`）。 */
export interface DailyReviewItem {
  readonly date: string;
  readonly answers: ReviewAnswers | null;
  readonly energyLevel: EnergyLevel | null;
  /** 尚未保存过为 `null`（事实摘要仍会返回）。 */
  readonly version: number | null;
  readonly createdAt: string | null;
  readonly facts: DailyFacts;
}

export interface WeeklyPlanActual {
  readonly plannedMinutes: number;
  readonly actualMinutes: number;
}

/** 四态计数（四桶恒存在，缺者为 0——UI 是四枚固定 Badge）。 */
export interface WeeklyTaskStatusCounts {
  readonly completed: number;
  readonly partial: number;
  readonly deferred: number;
  readonly skipped: number;
}

export interface WeeklyRepeatedDeferral {
  readonly taskId: string;
  readonly title: string;
  readonly deferCount: number;
}

export interface WeeklyGoalActions {
  readonly goalId: string;
  readonly goalName: string;
  readonly completed: number;
  readonly total: number;
}

export interface WeeklyExpenseCategoryTotal {
  readonly categoryId: string;
  readonly categoryName: string;
  /** 最小货币单位整数字符串。 */
  readonly totalMinor: string;
}

export interface WeeklyExpenseSummary {
  readonly currencyCode: string;
  readonly totalMinor: string;
  readonly byCategory: readonly WeeklyExpenseCategoryTotal[];
}

/** 调整五动作（接口 §10 表）。 */
export const ADJUSTMENT_ACTIONS = ['keep', 'shorten', 'defer', 'pause', 'delete'] as const;

export type AdjustmentAction = (typeof ADJUSTMENT_ACTIONS)[number];

export type AdjustmentTargetType = 'task' | 'goal';

/** 动作的中文名（B4 清单与 B3 按钮组共用一份，避免两处漂移）。 */
export const ADJUSTMENT_LABELS: Readonly<Record<AdjustmentAction, string>> = {
  keep: '保留',
  shorten: '缩短',
  defer: '移到下周',
  pause: '暂停目标',
  delete: '删除',
};

export interface ReviewAdjustmentItem {
  readonly id: string;
  readonly targetType: AdjustmentTargetType;
  readonly targetId: string;
  readonly action: AdjustmentAction;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/** `GET /reviews/weekly/{weekStart}` 的 `data`。 */
export interface WeeklyReviewItem {
  readonly weekStart: string;
  readonly planActual: WeeklyPlanActual;
  readonly taskStatusCounts: WeeklyTaskStatusCounts;
  readonly repeatedDeferrals: readonly WeeklyRepeatedDeferral[];
  readonly goalActions: readonly WeeklyGoalActions[];
  readonly expenseSummaries: readonly WeeklyExpenseSummary[];
  readonly adjustments: readonly ReviewAdjustmentItem[];
  /** 快照未物化（周未结束）为 `null`。 */
  readonly snapshotSchemaVersion: number | null;
}

/** 日复盘读取：`data` 为 `null` 表示「这天还没填写」（成功但没有内容，不是错误）。 */
export function fetchDailyReview(
  date: string,
  signal: AbortSignal,
): Promise<DailyReviewItem | null> {
  return fetchJson<DailyReviewItem | null>(`/api/v1/reviews/daily/${date}`, signal).then(
    (envelope) => envelope.data,
  );
}

/** 日复盘保存（幂等 upsert：同日重复 PUT 命中同一行、自增 `version`，不重复建行）。 */
export function saveDailyReview(
  date: string,
  body: { readonly answers: ReviewAnswers | null; readonly energyLevel: EnergyLevel | null },
): Promise<ApiEnvelope<DailyReviewItem>> {
  return sendJson<DailyReviewItem>('PUT', `/api/v1/reviews/daily/${date}`, body);
}

export function fetchWeeklyReview(
  weekStart: string,
  signal: AbortSignal,
): Promise<WeeklyReviewItem> {
  return fetchJson<WeeklyReviewItem>(`/api/v1/reviews/weekly/${weekStart}`, signal).then(
    (envelope) => envelope.data,
  );
}

/**
 * 提交一条调整（记录 + 执行同事务；接口 §10）。
 *
 * 返回**入列后的完整清单**，调用方直接替换本地清单即可，不必再取一次周复盘。
 * 刻意不带 `Idempotency-Key`：接口 §10 未强制该头（与执行记录的强制口径不同），
 * 而这里的重试是用户手动点击——让他看见失败并自己重试，比静默幂等重发更诚实。
 */
export function createReviewAdjustment(
  weekStart: string,
  body: {
    readonly targetType: AdjustmentTargetType;
    readonly targetId: string;
    readonly action: AdjustmentAction;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): Promise<ApiEnvelope<{ readonly adjustments: readonly ReviewAdjustmentItem[] }>> {
  return sendJson('POST', `/api/v1/reviews/weekly/${weekStart}/adjustments`, body);
}

/* ------------------------------------------------------------------ */
/* 周历运算（纯字符串，UTC 锚点）                                         */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/**
 * 本地日历日（`YYYY-MM-DD`）。
 *
 * 用**本地时区**而不是 UTC：用户说的「今天」是他手表上的今天（与 `queries.ts`
 * 的 `localCalendarDate` 同一口径）。IAM-002 落地后应按用户配置的 `timezone`
 * 计算——那是既有记债，本次不扩大范围。
 */
export function localCalendarDay(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

/** 日历日加减（`date` 为 `YYYY-MM-DD`）。 */
export function addDays(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 所在周的起始日。
 *
 * `weekStartsOn` 取用户设置（0 = 周日 … 6 = 周六，默认 1 = 周一，与 DB `period_key`
 * 「该周周一」的口径一致）。服务端按给定的 `weekStart` 起算 7 天窗口、不做周几校验，
 * 因此用户改成周日为周首时窗口随之平移，不会报错。
 */
export function startOfWeek(date: string, weekStartsOn: number): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((weekday - weekStartsOn + 7) % 7));
}

/** 周范围显示文案（`09-22 – 09-28`，B2 明文形状）。 */
export function formatWeekRange(weekStart: string): string {
  const end = addDays(weekStart, 6);
  return `${weekStart.slice(5)} – ${end.slice(5)}`;
}

/** 该日历日是否在给定日之后（用于「未来周不可选」「未来日期不可选」）。 */
export function isAfter(date: string, reference: string): boolean {
  return date > reference;
}

/** 分钟数 → `h:mm`（B0「时长一律 tabular-nums」；负数按绝对值渲染，符号另给）。 */
export function formatMinutes(minutes: number): string {
  const total = Math.abs(Math.trunc(minutes));
  return `${String(Math.trunc(total / 60))}:${String(total % 60).padStart(2, '0')}`;
}

/** 差值 → `±h:mm`（0 显示为 `0:00`，不带符号——「没有偏差」不该看起来像负偏差）。 */
export function formatSignedMinutes(minutes: number): string {
  if (minutes === 0) {
    return '0:00';
  }
  return `${minutes > 0 ? '+' : '-'}${formatMinutes(minutes)}`;
}

/**
 * 周窗口的闭区间末日（`GET /expense-summary` 的 `to`）。
 *
 * 周复盘的 `weekStart + 7` 是**排他**上界（执行记录的时间窗），而开销按 `occurred_on`
 * 过滤是闭区间，所以要 `+6`——把这两个口径分开写在这里，免得页面里各算一次。
 */
export function weekEndInclusive(weekStart: string): string {
  return addDays(weekStart, 6);
}

/** `GET /expense-summary` 的单组（`groupBy=category` 时 `key` 就是分类 id）。 */
export interface ExpenseSummaryGroup {
  readonly key: string | null;
  readonly label: string;
  readonly totals: readonly {
    readonly currencyCode: string;
    readonly totalMinor: string;
    readonly count: number;
  }[];
}

export interface ExpenseSummaryData {
  readonly groups: readonly ExpenseSummaryGroup[];
  readonly grandTotals: readonly {
    readonly currencyCode: string;
    readonly totalMinor: string;
    readonly count: number;
  }[];
}

/**
 * 某一周的开销摘要（B2 第 6 项的「按生活领域」那一块）。
 *
 * ## 为什么只有生活领域用这条接口
 *
 * 周复盘响应自带的 `expenseSummaries` 只有「按分类」维度（快照结构所限），而 B2
 * 第 6 项要求同时给出「按分类」与「按生活领域」两块。分类那一块取快照/实时响应
 * （过去周读的是**存量快照**，与 DB §4.11.2 的写入后不变性一致），生活领域这一块
 * 契约里没有快照承载，只能现取现算——**这是本批已声明的限制**：过去周的
 * 「按生活领域」分列反映的是**查看时**的数据，而非该周结束时的数据。
 */
export function fetchExpenseSummaryByLifeArea(
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<ExpenseSummaryData> {
  const params = new URLSearchParams({ from, to, groupBy: 'lifeArea' });
  return fetchJson<ExpenseSummaryData>(`/api/v1/expense-summary?${params.toString()}`, signal).then(
    (envelope) => envelope.data,
  );
}

/* ------------------------------------------------------------------ */
/* 周窗口内的计划任务（调整动作的候选集与目标名）                           */
/* ------------------------------------------------------------------ */

/** `GET /tasks` 返回项里本页消费的字段（接口 §4）。 */
export interface WeekTaskItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dueDate: string | null;
  readonly estimatedMinutes: number | null;
}

/**
 * 周窗口内的计划任务（`GET /tasks?from&to`，接口 §4）。
 *
 * ## 为什么需要这一条（周复盘响应里没有的东西）
 *
 * 两处缺口都落在它身上：① B2 第 7 项清单要显示「目标名」，而 `review_adjustments`
 * 只有 `targetId`；② B3 第 2 条洞察要选一个任务来调整，而周复盘响应只给**计数**
 * （`taskStatusCounts`），不给出未完成任务的清单。契约里没有「按 id 批查任务」的
 * 端点，所以这里取**本周窗口内的任务**（`from`/`to` = 本周起止），既是候选集的
 * 合理来源，也是名字解析的来源。
 *
 * ## 口径如实：候选集是「本周计划任务」全集，不是「未执行任务」子集
 *
 * 任务列表不含「本周是否执行过」这一位（那在 `execution_logs` 里，契约无集合端点），
 * 因此 B3 第 2 条洞察的候选集**等于**本周计划任务全集——计数来自服务端聚合，
 * 选择哪一条由用户决定，界面不假装替他筛过。该取舍已在交付报告中声明。
 */
export function fetchWeekTasks(
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<readonly WeekTaskItem[]> {
  const params = new URLSearchParams({ from, to, limit: '100' });
  return fetchJson<{ readonly items: readonly WeekTaskItem[] }>(
    `/api/v1/tasks?${params.toString()}`,
    signal,
  ).then((envelope) => envelope.data.items);
}

/** 周窗口末日的**排他**上界之后一天（`to` 用闭区间，见 `weekEndInclusive`）。 */
export function nextWeekDueDate(weekStart: string, taskDueDate: string | null): string {
  // 有原定日期就顺推到下周同一天，否则落到下周首日——两者都是「移到下周」的合理落位。
  return taskDueDate === null ? addDays(weekStart, 7) : addDays(taskDueDate, 7);
}
