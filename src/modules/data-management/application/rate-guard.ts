/**
 * 限流守卫（OPS-002；接口 §14「导入、导出和删除接口需要更严格限流」）。
 *
 * 与 AUTH-002 的限流同形态：端口注入（组合根给同一进程级单例）、用例内判定、
 * 超限抛 `RateLimitError`（429，统一文案与认证面同句——同一产品的「太频繁」
 * 只该有一句话）。键按用途分域（`data:<kind>:<userId>`），互不挤占窗口。
 */
import { RateLimitError } from '@/shared/errors/app-error.ts';

import type { RateLimiter } from '../domain/data-ports.ts';
import { rateLimitKey } from '../domain/limits.ts';

/**
 * 执行一次限流判定。
 *
 * @param kind 用途域（export/preview/confirm/…）。
 * @param userId 限流维度＝每用户（契约汇总表口径）。
 * @param limit 窗口内允许的次数。
 * @param windowMs 窗口长度。
 * @throws {RateLimitError} 超限时（429）。
 */
export function enforceLimit(
  limiter: RateLimiter,
  kind: string,
  userId: string,
  limit: number,
  windowMs: number,
): void {
  if (!limiter.consume(rateLimitKey(kind, userId), limit, windowMs)) {
    throw new RateLimitError('操作过于频繁，请稍后再试。');
  }
}
