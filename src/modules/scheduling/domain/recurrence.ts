/**
 * 重复规则（DB §4.5 最小结构冻结，Phase 4 启用）。
 *
 * `{ freq: 'daily'|'weekly', interval?, weekdays?, endsOn? }`——RRULE 的子集。
 * 解析校验、命中判定与窗口展开都收口在这一个文件，任务物化、固定事项
 * 物化、例程三个消费方共享同一份语义。
 */
import { ValidationError } from '@/shared/errors/app-error.ts';

import { addDays, weekdayOf } from './zoned-time.ts';

/** 冻结的最小规则结构（字段增减须规范升版）。 */
export interface RecurrenceRule {
  readonly freq: 'daily' | 'weekly';
  readonly interval: number;
  /** 0–6（0＝周日）；weekly 必填非空，daily 禁止给出。 */
  readonly weekdays: readonly number[];
  /** 可选日历日，该日之后不再展开。 */
  readonly endsOn: string | null;
}

/** 解析并校验规则（jsonb 进域前的单一出口）。 */
export function parseRecurrenceRule(value: unknown): RecurrenceRule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('重复规则必须是对象');
  }
  const record = value as Record<string, unknown>;
  const freq = record['freq'];
  if (freq !== 'daily' && freq !== 'weekly') {
    throw new ValidationError("重复规则的 freq 必须是 'daily' 或 'weekly'");
  }
  const rawInterval = record['interval'];
  if (rawInterval !== undefined && rawInterval !== null) {
    if (typeof rawInterval !== 'number' || !Number.isInteger(rawInterval) || rawInterval < 1) {
      throw new ValidationError('重复规则的 interval 必须是正整数');
    }
  }
  const interval = (rawInterval as number | undefined) ?? 1;
  const rawWeekdays = record['weekdays'];
  let weekdays: readonly number[] = [];
  if (rawWeekdays !== undefined && rawWeekdays !== null) {
    if (
      !Array.isArray(rawWeekdays) ||
      rawWeekdays.some(
        (day) => typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6,
      )
    ) {
      throw new ValidationError('重复规则的 weekdays 必须是 0–6 的整数数组（0＝周日）');
    }
    weekdays = [...rawWeekdays];
  }
  if (freq === 'weekly' && weekdays.length === 0) {
    throw new ValidationError('weekly 规则必须给出至少一个 weekday');
  }
  if (freq === 'daily' && weekdays.length > 0) {
    throw new ValidationError('daily 规则不允许给出 weekdays');
  }
  const rawEndsOn = record['endsOn'];
  let endsOn: string | null = null;
  if (rawEndsOn !== undefined && rawEndsOn !== null) {
    if (typeof rawEndsOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rawEndsOn)) {
      throw new ValidationError('重复规则的 endsOn 必须是 YYYY-MM-DD');
    }
    endsOn = rawEndsOn;
  }
  return { freq, interval, weekdays, endsOn };
}

/** 判定某日历日是否被规则命中（`interval` 的锚点是规则适用区间的第一天）。 */
export function ruleMatchesDate(rule: RecurrenceRule, anchorDate: string, date: string): boolean {
  if (rule.endsOn !== null && date > rule.endsOn) {
    return false;
  }
  if (date < anchorDate) {
    return false;
  }
  const diffDays = Math.floor(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${anchorDate}T00:00:00Z`)) / 86_400_000,
  );
  // weekly：先过 weekday 过滤，再按"整周数"数 interval——命中条件是
  // `floor(diffDays/7) % interval === 0`（2026-09-22 审查修正：此前误用
  // `diffDays % (interval*7)`，与锚点不同 weekday 的日子全部漏判）。
  if (rule.freq === 'weekly') {
    if (!rule.weekdays.includes(weekdayOf(date))) {
      return false;
    }
    return Math.floor(diffDays / 7) % rule.interval === 0;
  }
  return diffDays % rule.interval === 0;
}

/**
 * 展开规则在 `[from, to]` 窗口内的命中日期（升序）。
 *
 * `interval > 1` 的展开需要锚点日——任务模板即 `created_at` 的日历日、
 * 固定事项模板即首建日；调用方必须传入，本函数不猜测。
 */
export function expandRuleDates(
  rule: RecurrenceRule,
  anchorDate: string,
  from: string,
  to: string,
): readonly string[] {
  const hit: string[] = [];
  // 从锚点逐步走到窗口尾（interval 语义要求从锚点数起，不能只在窗口内取模）。
  for (let date = anchorDate; date <= to; date = addDays(date, 1)) {
    if (date >= from && ruleMatchesDate(rule, anchorDate, date)) {
      hit.push(date);
    }
  }
  return hit;
}
