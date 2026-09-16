/**
 * 用户标识匿名化（FND-005）。
 *
 * SRS NFR-PRIV-007 要求日志与统计默认使用匿名化 ID，NFR-REL-006 要求错误
 * 能关联到用户匿名标识。两者合起来意味着：日志里需要的是一个**稳定但不可逆**
 * 的用户标识——同一用户始终得到同一个值（可聚合），但拿不到 user id 本身。
 *
 * 为什么不用随机盐：盐需要作为密钥管理（轮换、分发、保密），
 * 而日志匿名化并不需要抗暴力破解——user id 是 UUID，空间大到无法枚举。
 * 引入盐只会把「日志依赖」变成「日志依赖 + 密钥依赖」。
 */
import { createHash } from 'node:crypto';

/** 输出长度（十六进制字符）。16 字符 = 64 位，碰撞概率对日志聚合而言可忽略。 */
const ANONYMOUS_ID_LENGTH = 16;

/**
 * 把用户 ID 转换为匿名标识。
 *
 * @param userId 用户 ID（UUID）。
 * @returns SHA-256 的前 16 个十六进制字符。
 * @throws {TypeError} 入参为空或纯空白时抛出——静默返回空值会让日志里出现
 *   一批无法区分来源的记录，比直接失败更糟。
 */
export function toAnonymousUserId(userId: string): string {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new TypeError('userId 必须是非空字符串');
  }

  return createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, ANONYMOUS_ID_LENGTH);
}
