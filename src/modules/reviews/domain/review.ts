/**
 * 复盘实体（REVIEW-001，DB §4.11.1、SRS FR-060）。
 *
 * 日/周两类复盘共用一张表：`review_type` + `period_key` 区分。日复盘的
 * `period_key` 是**用户时区下的日历日**，周复盘是该周周一的日历日——两者都是
 * 「日历日字符串」，不转 UTC（DB §4.11.1 与 `date` 列的既有口径一致）。
 *
 * ## 为什么不设 `deleted_at`
 *
 * 本批没有删除入口（「跳过今天」是纯前端动作、不落记录，UI 规范 B1），因此不留
 * 「无写入路径的死列」——预审裁定 C.4 采 B，同 §4.18.3 对 `life_areas` 的结论。
 * `reviews` 在同步链路归入**无删除语义**类，`deleted` 恒 `false`。
 */
import type { EnergyLevel } from '../../execution/domain/execution-log.ts';
import type { WeeklySnapshot } from './weekly-snapshot.ts';

/** 复盘类型（DB §4.11.1 的 `varchar(8)`）。 */
export const REVIEW_TYPES = ['daily', 'weekly'] as const;

export type ReviewType = (typeof REVIEW_TYPES)[number];

/**
 * 日复盘三问的键（FR-060；三键**均可省略**，可只答一题或整体跳过）。
 *
 * 顺序即 UI 三卡的呈现顺序，因此这里用数组而不是对象：顺序是契约的一部分
 * （UI 规范 B1 的三卡纵向顺序），对象键顺序在语言层面不足以承载它。
 */
export const REVIEW_ANSWER_KEYS = ['completed', 'blocker', 'nextAdjustment'] as const;

export type ReviewAnswerKey = (typeof REVIEW_ANSWER_KEYS)[number];

/** 单题答案的文本上限（库层是 `jsonb`、无长度约束，这里是接口层的边界上限）。 */
export const REVIEW_ANSWER_MAX_LENGTH = 2000;

/**
 * 日复盘三问的答案集合。
 *
 * 键可缺省（＝未答）；应用层保证不会出现空串值——空串在入参校验处就按「未答」
 * 归一为「键不存在」，这样「有键但值为空」这种第三种状态不存在。
 */
export type ReviewAnswers = Partial<Record<ReviewAnswerKey, string>>;

/** 复盘实体。 */
export interface Review {
  readonly id: string;
  readonly userId: string;
  readonly reviewType: ReviewType;
  /** 日复盘＝日历日；周复盘＝该周周一（均为 `YYYY-MM-DD`，无时区语义）。 */
  readonly periodKey: string;
  /** 日复盘三问（周复盘为 `null`）。 */
  readonly answers: ReviewAnswers | null;
  readonly energyLevel: EnergyLevel | null;
  /** 周复盘结构化快照（日复盘为 `null`）；与 `snapshotSchemaVersion` 同生共死。 */
  readonly snapshot: WeeklySnapshot | null;
  readonly snapshotSchemaVersion: number | null;
  readonly createdAt: string;
  readonly version: number;
}

/** 日复盘 upsert 的输入（键可缺省＝未答；`null` 表示整体未答）。 */
export interface DailyReviewUpsertInput {
  readonly answers: ReviewAnswers | null;
  readonly energyLevel: EnergyLevel | null;
}

/** `YYYY-MM-DD` 形状判定（与 `date` 列的既有校验同源，不引入新日期库）。 */
export function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 已答题目是否为空（没有任何键）。 */
export function isEmptyAnswers(answers: ReviewAnswers | null): boolean {
  return answers === null || Object.keys(answers).length === 0;
}

/**
 * 从数据库回读的 `jsonb` 还原成答案集合。
 *
 * 只保留三问里的键与字符串值：库里可能有历史遗留或人工写的 JSON，放行它等于
 * 让「未知键」一路漂到响应里。返回 `null` 表示这一列没有内容。
 */
export function readReviewAnswers(value: unknown): ReviewAnswers | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const answers: Partial<Record<ReviewAnswerKey, string>> = {};
  for (const key of REVIEW_ANSWER_KEYS) {
    const entry = record[key];
    if (typeof entry === 'string' && entry !== '') {
      answers[key] = entry;
    }
  }
  return Object.keys(answers).length === 0 ? null : answers;
}

/** `review_type` 回读判定（不在契约集合内即视为数据损坏，由仓储抛领域错误）。 */
export function isReviewType(value: string): value is ReviewType {
  return (REVIEW_TYPES as readonly string[]).includes(value);
}
