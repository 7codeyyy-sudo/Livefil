/**
 * AI 额度周期（RD-20260929-006 §1.5「自然月，按用户时区」）。
 *
 * ## 为什么把这一步抽成一处
 *
 * 额度有**两个**消费点：调用前的预检（`invoke-ai-provider.ts`）与 `GET /ai/usage`
 * 的展示（`get-ai-usage.ts`）。两处若各算各的月首，就会出现「预检按 UTC 切、展示按
 * 用户时区切」的口径差——用户在月初看到「剩余 200 次」，实际第 3 次就被 429 拦下。
 * 这类差异不会在单侧测试里暴露，只能在跨时区的月末/月初边界上被用户撞见。
 *
 * 因此周期计算只留这一份实现，两处共同引用。
 *
 * ## 为什么不能用 UTC 直接算
 *
 * `now` 是 UTC 瞬时。对 `Asia/Shanghai` 的用户而言，1 日 00:00（+08:00）对应的是
 * 上月最后一天 16:00Z——直接按 `getUTCMonth()` 取月首会把「用户以为的本月」错开
 * 整整一个月的前 8 小时。正确做法是先在用户时区上取出「此刻的日历日」，再把这个
 * 日历日的月份首日还原回 UTC 瞬时。
 */
import { calendarDayOf, zonedToUtc } from '../../scheduling/domain/zoned-time.ts';

/** 一个额度周期：起点（含）与重置时刻（＝下一周期起点）。 */
export interface AiBillingPeriod {
  /** 本周期起点在用户时区的当月 1 日 00:00 对应的 UTC 瞬时。 */
  readonly start: Date;
  /** 下周期起点＝额度重置时刻（同口径）。 */
  readonly resetAt: Date;
}

/**
 * 求「此刻」所属的额度周期（用户时区自然月）。
 *
 * @param now 当前 UTC 瞬时。
 * @param timezone 用户设置的 IANA 时区名。
 */
export function resolveAiBillingPeriod(now: Date, timezone: string): AiBillingPeriod {
  // `calendarDayOf` 给出用户时区下的 `YYYY-MM-DD`，取其年月部分即为「用户视角的本月」。
  const localMonth = calendarDayOf(now, timezone).slice(0, 7);
  const month = Number(localMonth.slice(5, 7));
  const year = localMonth.slice(0, 4);

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? String(Number(year) + 1) : year;

  return {
    start: zonedToUtc(`${localMonth}-01`, '00:00', timezone),
    resetAt: zonedToUtc(`${nextYear}-${pad2(nextMonth)}-01`, '00:00', timezone),
  };
}

/** 月份补零（`1` → `01`）。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
