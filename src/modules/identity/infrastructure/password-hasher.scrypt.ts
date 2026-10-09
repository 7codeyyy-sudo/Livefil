/**
 * scrypt 密码哈希（AUTH-002，《接口文档》v0.8 密码规则；RD-012 §8.1）。
 *
 * ## 为什么是 scrypt 而不是 bcrypt/argon2
 *
 * Node 内置 `crypto.scrypt`——零新依赖（事故 002 纪律，PD-025 护栏 2）。
 * bcrypt/argon2 需要第三方包（含原生编译），在本项目「5–20 用户、2C2G 单实例」
 * 的规模下没有换来任何实际安全收益，却引入锁文件与跨平台构建面。
 *
 * ## 参数随串存储
 *
 * 编码格式 `scrypt$N$r$p$salt$hash`——参数写进串里，日后升参时新旧哈希
 * 可共存（校验按串内参数重算），不需要一次全量改密。
 *
 * ## 恒定时间比较
 *
 * 校验用 `timingSafeEqual`：普通 `===` 在首个不同字节处返回，耗时与匹配
 * 前缀长度相关——那是一个可被测量的信息通道。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import type { PasswordHasher } from '../domain/password-hasher.ts';

/** 对数内存成本：32768 × 128 × r ≈ 32 MiB/次（RD-012 §8.1 定值）。 */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** 派生密钥长度（字节）。 */
const KEY_LENGTH = 64;
/** 盐长度（字节）。 */
const SALT_LENGTH = 16;
/** scrypt 计算需要 128×N×r×p 字节，给足上限留白（默认 32 MiB 会不够）。 */
const MAX_MEM = 96 * 1024 * 1024;

function scryptAsync(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEM }, (error, derived) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derived);
    });
  });
}

/** 编码串 → 参数与盐/哈希；格式不符返回 null（坏数据是常态，不抛错）。 */
function parseEncoded(
  encoded: string,
): { n: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return null;
  }
  try {
    return {
      n,
      r,
      p,
      salt: Buffer.from(saltRaw ?? '', 'base64url'),
      hash: Buffer.from(hashRaw ?? '', 'base64url'),
    };
  } catch {
    return null;
  }
}

/** 创建密码哈希器（工厂形态对齐 `createSessionSigner`：装配期构造，用例只拿端口）。 */
export function createScryptPasswordHasher(): PasswordHasher {
  return {
    async hash(plainPassword: string): Promise<string> {
      const salt = randomBytes(SALT_LENGTH);
      const derived = await scryptAsync(plainPassword, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
      return [
        'scrypt',
        String(SCRYPT_N),
        String(SCRYPT_R),
        String(SCRYPT_P),
        salt.toString('base64url'),
        derived.toString('base64url'),
      ].join('$');
    },

    async verify(plainPassword: string, encoded: string): Promise<boolean> {
      const parsed = parseEncoded(encoded);
      if (parsed === null) {
        // 损坏的编码串＝校验失败，不是服务器故障——库里出现它说明有人绕过
        // 应用直写了数据，返回 false 让调用方走统一的凭据错误路径。
        return false;
      }

      let derived: Buffer;
      try {
        derived = await scryptAsync(plainPassword, parsed.salt, parsed.n, parsed.r, parsed.p);
      } catch {
        // 参数合法但内存不足之类的计算失败：按校验失败处理，不把内部细节抛给调用方。
        return false;
      }

      if (derived.length !== parsed.hash.length) {
        return false;
      }
      return timingSafeEqual(derived, parsed.hash);
    },
  };
}
