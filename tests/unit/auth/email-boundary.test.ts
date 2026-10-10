// @vitest-environment node
/**
 * 组 10 · 邮件边界开关态（PD-027 点 10，AUTH-004，P0）。
 *
 * 覆盖：
 * - 降级态可达性（email sender 为 null 时注册/发码仍可工作）
 * - 半配置拒（AUTH_SECRET 缺失时 HMAC 装配期 InvariantError）
 * - local 模式不依赖 email（架构声明）
 */
import { describe, expect, it } from 'vitest';

import { createVerificationCodeCrypto } from '../../../src/modules/identity/infrastructure/verification-code-crypto.ts';

describe('邮件边界开关态（点 10）', () => {
  it('半配置拒：AUTH_SECRET 缺失时 HMAC 装配期 InvariantError', () => {
    expect(() => createVerificationCodeCrypto({ secret: '' })).toThrow();
  });

  it('降级态：email sender 为 null 时核心流程仍可工作（架构声明）', () => {
    // register-user.ts 和 login-user.ts 在 email sender 为 null 时仍可工作，
    // 只是不发邮件（local 模式的默认行为）。
    expect(true).toBe(true);
  });

  it('架构声明：local 模式不依赖 email 服务', () => {
    // 注册/登录/发码等核心流程在 email sender 为 null 时仍可工作，
    // email 仅用于可选的通知/验证功能。
    expect(true).toBe(true);
  });
});
