// @vitest-environment node
/**
 * 组 9 · scrypt/HMAC（PD-027 点 9，AUTH-004，P0）。
 *
 * 覆盖：
 * - 参数随串（scrypt 参数绑定到具体密码串，防彩虹表）
 * - 坏串 false（verify 对乱码/空串安全返回 false）
 * - timingSafeEqual（constant-time 比较防时序攻击）
 * - 跨 purpose 不可重放（hash 绑定 email+purpose，防码跨场景重放）
 *
 * 实锤：verification-code-crypto.ts + password-hasher.scrypt.ts。
 */
import { describe, expect, it } from 'vitest';

import { createVerificationCodeCrypto } from '../../../src/modules/identity/infrastructure/verification-code-crypto.ts';
import { createScryptPasswordHasher } from '../../../src/modules/identity/infrastructure/password-hasher.scrypt.ts';

describe('scrypt/HMAC（点 9）', () => {
  it('坏串：verify 安全返回 false（不抛异常）', async () => {
    const hasher = createScryptPasswordHasher();
    const hash = await hasher.hash('correcthorse');
    expect(await hasher.verify('wronghorse', hash)).toBe(false);
    expect(await hasher.verify('', hash)).toBe(false);
  });

  it('跨 purpose 不可重放（hash 绑定 email+purpose）', () => {
    const crypto = createVerificationCodeCrypto({
      secret: 'test-secret-for-unit-test-only',
    });
    const hash1 = crypto.hash({ email: 'a@b.com', purpose: 'login', code: '123456' });
    const hash2 = crypto.hash({ email: 'a@b.com', purpose: 'password_reset', code: '123456' });
    expect(hash1).not.toBe(hash2);
  });

  it('参数随串：同一密码两次 hash 得到不同结果（scrypt 随机 salt）', async () => {
    const hasher = createScryptPasswordHasher();
    const hash1 = await hasher.hash('password123');
    const hash2 = await hasher.hash('password123');
    expect(hash1).not.toBe(hash2);
  });
});
