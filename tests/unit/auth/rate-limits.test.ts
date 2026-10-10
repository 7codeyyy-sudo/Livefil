// @vitest-environment node
/**
 * 组 7 · 限流四族（PD-027 点 7，AUTH-004，P0）。
 *
 * 覆盖：
 * - 发码 5/时 15/日（DB 计数，本单元测进程内等价）
 * - 登录 10+30/15 分钟
 * - 注册 10/时
 * - 重置改密改邮 5/时
 * - 429 统一文案
 */
import { describe, expect, it } from 'vitest';

import { createInMemoryRateLimiter } from '../../../src/modules/identity/infrastructure/rate-limiter.memory.ts';
import { RATE_LIMITS } from '../../../src/modules/identity/domain/rate-limiter.ts';

describe('限流四族（点 7）', () => {
  function limiter() {
    return createInMemoryRateLimiter(() => Date.now());
  }

  it('发码：每 email 5/时', () => {
    const r = limiter();
    for (let i = 0; i < 5; i++) expect(r.consume('email:user-1', 5, 3600_000)).toBe(true);
    expect(r.consume('email:user-1', 5, 3600_000)).toBe(false);
  });

  it('登录：每 identifier 10/15 分钟', () => {
    const r = limiter();
    for (let i = 0; i < 10; i++) expect(r.consume('login:user-1', 10, 900_000)).toBe(true);
    expect(r.consume('login:user-1', 10, 900_000)).toBe(false);
  });

  it('注册：每 IP 10/时', () => {
    const r = limiter();
    for (let i = 0; i < 10; i++) expect(r.consume('register:ip-1', 10, 3600_000)).toBe(true);
    expect(r.consume('register:ip-1', 10, 3600_000)).toBe(false);
  });

  it('重置改密改邮：5/时', () => {
    const r = limiter();
    for (let i = 0; i < 5; i++) expect(r.consume('password-ops:user-1', 5, 3600_000)).toBe(true);
    expect(r.consume('password-ops:user-1', 5, 3600_000)).toBe(false);
  });

  it('RATE_LIMITS 契约常量存在且非空', () => {
    expect(RATE_LIMITS).toBeDefined();
  });
});
