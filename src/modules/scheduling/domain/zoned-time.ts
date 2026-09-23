/**
 * 时区感知的时间换算（SCHED-001/EXEC，《数据库设计》§4.6、SRS 时间规范）。
 *
 * ## 为什么放 scheduling 领域
 *
 * 「本地钟点 + 日历日 + IANA 时区 → UTC 瞬时」不是 IO，是纯领域规则；
 * 固定事项物化、例程展开、/today 窗口切割都依赖它，收口在一个纯函数文件里，
 * 三个消费方（scheduling / routines / execution）共享同一份 DST 语义。
 *
 * ## DST 为什么必须两轮收敛
 *
 * `Date.parse('…Z')` 得到的是"把本地钟点当 UTC"的假瞬时。真实偏移取决于
 * **那一瞬**所处的时区规则（夏令时边界上同一钟点偏移不同），所以用
 * `Intl` 取偏移 → 修正 → 再取一次（两轮足够：偏移变化只有 ±1h 一档）。
 */
import { ValidationError } from '@/shared/errors/app-error.ts';

/** 校验 IANA 时区名并返回（非法时 `Intl` 抛 RangeError，转 400）。 */
export function assertTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new ValidationError(`非法的时区名称：${timeZone}`);
  }
  return timeZone;
}

/** 某瞬时在指定时区的偏移量（毫秒，东正西负）。 */
function timeZoneOffsetMs(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const match = /GMT([+-])(\d{1,2}):(\d{2})/.exec(name);
  if (match === null) {
    return 0;
  }
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return sign * (hours * 60 + minutes) * 60_000;
}

/**
 * 本地钟点 → UTC 瞬时（DST 安全）。
 *
 * @param date 日历日 `YYYY-MM-DD`（按 `timeZone` 解释）。
 * @param localTime `HH:MM`。
 * @param timeZone IANA 时区（须已过 {@link assertTimeZone}）。
 */
export function zonedToUtc(date: string, localTime: string, timeZone: string): Date {
  const naive = Date.parse(`${date}T${localTime}:00Z`);
  if (Number.isNaN(naive)) {
    throw new ValidationError(`无法解析本地时间：${date} ${localTime}`);
  }
  let timestamp = naive;
  for (let round = 0; round < 2; round += 1) {
    timestamp = naive - timeZoneOffsetMs(timeZone, new Date(timestamp));
  }
  return new Date(timestamp);
}

/** UTC 瞬时 → 指定时区的 `{ date, time }` 本地表示。 */
export function utcToZoned(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const hour = read('hour') === '24' ? '00' : read('hour');
  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    time: `${hour}:${read('minute')}`,
  };
}

/** UTC 瞬时在指定时区的日历日。 */
export function calendarDayOf(instant: Date, timeZone: string): string {
  return utcToZoned(instant, timeZone).date;
}

/** 两个日历日之间的天数（含端点为 +1）；`YYYY-MM-DD` 直接按 UTC 解析无时区陷阱。 */
export function daysInclusive(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

/** 日历日 +n 天（UTC 语义上的纯日历运算）。 */
export function addDays(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** 日历日的星期（0＝周日，与 recurrence 的 weekdays 口径一致）。 */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
