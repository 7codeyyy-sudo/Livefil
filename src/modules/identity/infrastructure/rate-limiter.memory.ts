/**
 * 进程内滑动窗口限流（AUTH-002，RD-012 §4.2 / §11-5 单实例边界申报）。
 *
 * ## 为什么是进程内而不是 DB
 *
 * 登录/注册族的限流键包含 **IP 维度**——IP 不入库（存了就是新的隐私面与
 * 清理负担），且甲案部署形态就是单实例多租户（spike §3），进程内窗口与
 * 部署事实一致。发码族的 **email 维度**走 DB 窗口计数（`email_verification_codes`
 * 的 created_at 索引），重启不失效——两族各取所长。
 *
 * **已知边界（如实申报，非待定）**：进程内状态随重启清零、多实例不共享；
 * 多实例化时须换共享存储（RD-012 §11-5）。
 *
 * ## 滑动窗口而不是固定窗口
 *
 * 固定窗口在窗口边界处允许瞬时双倍量（23:59 打满 + 00:01 再打满），
 * 而暴力破解恰恰喜欢这种边界。滑动窗口只看「最近 N 毫秒内的事件」。
 */
import type { RateLimiter } from '../domain/rate-limiter.ts';

/** 单键事件条数的硬上限——防「一个高频键把内存吃光」（超出即丢最老）。 */
const MAX_EVENTS_PER_KEY = 256;
/** 空闲键的惰性清扫阈值：键数超过它时顺手清一次过期条目。 */
const SWEEP_THRESHOLD = 1024;

export function createInMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  /** key → 事件时间戳（升序）。 */
  const windows = new Map<string, number[]>();

  function sweep(cutoff: number): void {
    for (const [key, events] of windows) {
      const kept = events.filter((timestamp) => timestamp > cutoff);
      if (kept.length === 0) {
        windows.delete(key);
      } else {
        windows.set(key, kept);
      }
    }
  }

  return Object.freeze({
    consume(key: string, limit: number, windowMs: number): boolean {
      const current = now();
      const cutoff = current - windowMs;

      let events = windows.get(key);
      if (events === undefined) {
        events = [];
        windows.set(key, events);
        // 惰性清扫：只在键数可观时做，避免每个请求都全表扫。
        if (windows.size > SWEEP_THRESHOLD) {
          sweep(cutoff);
          events = windows.get(key) ?? [];
        }
      }

      // 丢弃窗口外的旧事件（数组升序，从头开始都是过期的）。
      let start = 0;
      while (start < events.length && (events[start] ?? 0) <= cutoff) {
        start += 1;
      }
      if (start > 0) {
        events.splice(0, start);
      }

      if (events.length >= limit) {
        return false;
      }

      events.push(current);
      // 硬上限：超限时丢最老一条（保新拒旧——限流器宁可漏掉一次历史计数，
      // 也不能让攻击者用一个键撑爆内存）。
      if (events.length > MAX_EVENTS_PER_KEY) {
        events.splice(0, events.length - MAX_EVENTS_PER_KEY);
      }
      return true;
    },
  });
}
