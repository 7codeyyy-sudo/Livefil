/**
 * 测试用可控时钟（FND-003）。
 *
 * 时间相关逻辑若直接读系统时钟，测试就会依赖真实时间：跨秒、跨日或跨时区
 * 运行都可能出现偶发失败，而且「时间前进」无法被显式驱动。
 * 这里提供可注入、可推进的时钟，并统一以 UTC ISO 字符串输出，
 * 对应《数据库设计文档》§3 对 `timestamptz` 列的规定。
 */

/** 默认起始时刻。取固定值而非当前时间，保证「不传起始时刻」同样可复现。 */
const DEFAULT_START_TIME = '2026-01-01T00:00:00.000Z';

export interface Clock {
  /** 当前时刻的独立副本。返回副本可防止调用方通过改写 Date 影响时钟内部状态。 */
  readonly now: () => Date;
  /** 当前时刻的 UTC ISO 字符串（毫秒精度），可直接写入 `timestamptz` 列。 */
  readonly isoNow: () => string;
  /** 将时钟向前推进指定毫秒数，并返回推进后的时刻。 */
  readonly advance: (milliseconds: number) => Date;
}

/**
 * 创建可控时钟。
 *
 * @param startTime 起始时刻；接受 ISO 字符串或 Date，默认 {@link DEFAULT_START_TIME}。
 * @returns 可控时钟；已冻结。
 * @throws {RangeError} 起始时刻无法解析为有效日期时抛出。
 */
export function createClock(startTime: string | Date = DEFAULT_START_TIME): Clock {
  const resolved = startTime instanceof Date ? new Date(startTime.getTime()) : new Date(startTime);

  if (Number.isNaN(resolved.getTime())) {
    throw new RangeError(`时钟起始时刻无法解析为有效日期：${String(startTime)}`);
  }

  let current = resolved;

  const now = (): Date => new Date(current.getTime());

  const advance = (milliseconds: number): Date => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError(`advance 仅接受非负毫秒数，实际收到 ${String(milliseconds)}`);
    }
    current = new Date(current.getTime() + milliseconds);
    return new Date(current.getTime());
  };

  return Object.freeze({ now, isoNow: () => current.toISOString(), advance });
}
