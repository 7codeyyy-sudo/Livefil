/**
 * 验证码的生成与 HMAC 哈希（AUTH-002，《数据库设计文档》§4.20；RD-012 §8.1）。
 *
 * - 生成用 `randomInt(0, 1_000_000)`：密码学均匀分布——`Math.random` 取模对
 *   低位有可测偏差，而验证码的全部熵就在六位数字里。
 * - 哈希用 HMAC-SHA256，密钥＝**从 AUTH_SECRET 分域派生**（`deriveKey`）：
 *   与会话签名共用一个根密钥但域分离，任何一侧的签名构造能力都不能跨用
 *   到另一侧的码值上（域分离是 HMAC 多用途密钥的标准纪律）。
 * - 消息＝`purpose|email|code`：同一个码换个用途或换个邮箱就对不上——
 *   跨 purpose 重放（安全矩阵 #8）在哈希层就被掐死。
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import type { VerificationCodeCrypto, VerificationPurpose } from '../domain/verification-code.ts';
import { CODE_LENGTH } from '../domain/verification-code.ts';
import { InvariantError } from '@/shared/errors/app-error.ts';

/** 密钥派生的域标签（与会话签名的用途分离）。 */
const KEY_DOMAIN = 'livefil:email-verification-code:v1';

export function createVerificationCodeCrypto(options: {
  readonly secret: string | undefined;
}): VerificationCodeCrypto {
  const secret = options.secret?.trim();
  if (secret === undefined || secret === '') {
    // 只报变量名，不回显取值（NFR-SEC-002）；装配期失败（§8.3）。
    throw new InvariantError({ message: '验证码 HMAC 密钥未配置（AUTH_SECRET）' });
  }

  // 分域派生一次，后续每码复用——派生本身与码值无关，不构成性能热点。
  const derivedKey = createHmac('sha256', secret).update(KEY_DOMAIN).digest();

  return Object.freeze({
    generate(): string {
      // randomInt 是闭区间 [0, 10^6)，补零到 6 位。
      return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
    },

    hash(input: { email: string; purpose: VerificationPurpose; code: string }): string {
      const message = `${input.purpose}|${input.email}|${input.code}`;
      return createHmac('sha256', derivedKey).update(message).digest('hex');
    },
  });
}

/** 恒定时间十六进制比对（库侧 consume 判定用；长度不等直接 false）。 */
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
