/**
 * 提醒触发时刻的解析（NOTIFY-001/002，读时物化的纯领域规则）。
 *
 * 读时物化要回答的问题只有一句：**「这条规则此刻应不应该产生一条待处理提醒，
 * 若应该，`scheduled_for` 是哪一刻？」** 本文件是它的全部答案，纯函数、无 IO，
 * 因此可以脱离数据库把边界（跨时区、跨午夜安静时段、周重复锚点）逐条测出来。
 *
 * ## 为什么锚点这样取（冻结文本未写死的部分，此处是唯一准据）
 *
 * - `daily`：今天（用户时区）；
 * - `weekly`：**规则创建日所在星期**的那一天——规则行没有"星期几"列，而
 *   `created_at` 是唯一稳定且可复算的锚点；用"当前星期"会让每周的锚点漂移，
 *   同一个规则在不同周产生不同触发日；
 * - `none`：创建时刻之后**第一次**到达 `remind_at` 的那一天，此后不再产生新条
 *   （去重键 `(rule_id, scheduled_for)` 使其天然只落一行）。
 *
 * ## 安静时段是「顺延」而不是「丢弃」
 *
 * 未勾选豁免的条目落在安静时段内时，**并入原条顺延**到安静时段结束（PM 补节 C 第 6 条：
 * 时段结束后并入原条顺延，**不产生新条目**）——因此这里是同一个 `scheduled_for`
 * 被整体后移，而不是"丢掉今天这条"。
 */
import {
  addDays,
  calendarDayOf,
  utcToZoned,
  weekdayOf,
  zonedToUtc,
} from '@/modules/scheduling/domain/zoned-time.ts';

import type { NotificationRepeatRule } from './notification-rule.ts';

/** 解析所需的环境事实（全部来自 `users` 行与请求时刻）。 */
export interface ReminderOccurrenceContext {
  readonly timeZone: string;
  /** 服务端当前时刻。 */
  readonly now: Date;
  /** `users.quiet_hours_start`（`HH:MM:SS`，可空）。 */
  readonly quietHoursStart: string | null;
  /** `users.quiet_hours_end`（`HH:MM:SS`，可空）。 */
  readonly quietHoursEnd: string | null;
}

/** 待解析的规则侧事实。 */
export interface ReminderScheduleInput {
  /** `HH:MM:SS`（用户时区下的本地时刻）。 */
  readonly remindAt: string;
  readonly repeatRule: NotificationRepeatRule;
  readonly allowQuietHours: boolean;
  /** 规则的 `created_at`（ISO 8601）。 */
  readonly createdAt: string;
}

/** `HH:MM:SS` / `HH:MM` → `HH:MM`（`zonedToUtc` 只吃分钟粒度）。 */
function toClock(value: string): string {
  return value.slice(0, 5);
}

/** 本次应触发的**日历日**（用户时区）。 */
function resolveCandidateDay(
  input: ReminderScheduleInput,
  context: ReminderOccurrenceContext,
): string {
  const localDay = calendarDayOf(context.now, context.timeZone);
  const createdInstant = new Date(input.createdAt);

  if (input.repeatRule === 'daily') {
    return localDay;
  }

  if (input.repeatRule === 'weekly') {
    // 锚点＝创建日所在星期；往前回退到最近一个锚点日（今天恰好是锚点日时回退 0 天）。
    const anchorWeekday = weekdayOf(calendarDayOf(createdInstant, context.timeZone));
    const back = (weekdayOf(localDay) - anchorWeekday + 7) % 7;
    return addDays(localDay, -back);
  }

  // `none`：创建之后第一次到达提醒时刻的那一天。
  const createdDay = calendarDayOf(createdInstant, context.timeZone);
  const createdClock = utcToZoned(createdInstant, context.timeZone).time;
  return createdClock <= toClock(input.remindAt) ? createdDay : addDays(createdDay, 1);
}

/** 落在安静时段内且未豁免时，顺延到安静时段结束（可能跨午夜）。 */
function shiftOutOfQuietHours(
  occurrence: Date,
  candidateDay: string,
  input: ReminderScheduleInput,
  context: ReminderOccurrenceContext,
): Date {
  if (input.allowQuietHours) {
    return occurrence;
  }

  const start = context.quietHoursStart === null ? null : toClock(context.quietHoursStart);
  const end = context.quietHoursEnd === null ? null : toClock(context.quietHoursEnd);
  // 起止相同（或只配了一端）不构成一个时段，按"无安静时段"处理，不做顺延。
  if (start === null || end === null || start === end) {
    return occurrence;
  }

  const localClock = utcToZoned(occurrence, context.timeZone).time;
  const crossesMidnight = start > end;
  const inQuietHours = crossesMidnight
    ? localClock >= start || localClock < end
    : localClock >= start && localClock < end;

  if (!inQuietHours) {
    return occurrence;
  }

  // 跨午夜且已过起点 ⇒ 结束时刻落在次日。
  const endDay = crossesMidnight && localClock >= start ? addDays(candidateDay, 1) : candidateDay;
  return zonedToUtc(endDay, end, context.timeZone);
}

/**
 * 本次应触发的时刻。
 *
 * @returns 触发时刻；**尚未到点**（或在安静时段内还没等到结束）时返回 `null`
 *   ——调用方据此决定本次不物化，下一次读取再算一次。
 */
export function resolveReminderOccurrence(
  input: ReminderScheduleInput,
  context: ReminderOccurrenceContext,
): Date | null {
  const candidateDay = resolveCandidateDay(input, context);
  const occurrence = zonedToUtc(candidateDay, toClock(input.remindAt), context.timeZone);

  if (occurrence.getTime() > context.now.getTime()) {
    return null;
  }

  const shifted = shiftOutOfQuietHours(occurrence, candidateDay, input, context);

  // 顺延后的时刻可能仍在未来（安静时段尚未结束）——那时同样不物化。
  return shifted.getTime() > context.now.getTime() ? null : shifted;
}
