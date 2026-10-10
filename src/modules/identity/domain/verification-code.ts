/**
 * 邮箱验证码领域与仓储端口（AUTH-002，《数据库设计文档》§4.20，RD-012 §2.4）。
 *
 * 挂账 5「邮件/验证码通道」解锁落点。终审确认口径（PD-016 L108）：
 * 6 位 / 10 分钟 / 错 5 次作废 / 每邮箱限流 / 统一文案防枚举。
 *
 * 哈希在域外做（HMAC 需要密钥，属基础设施的签名职责）——本域只管
 * 「码的生命周期状态机」：单活跃、一次性、attempts 计数、过期。
 */

/** 验证码用途。跨 purpose 不可用（安全矩阵 #8 的落点）。 */
export type VerificationPurpose = 'register' | 'login' | 'password_reset' | 'change_email';

export function isVerificationPurpose(value: string): value is VerificationPurpose {
  return (
    value === 'register' ||
    value === 'login' ||
    value === 'password_reset' ||
    value === 'change_email'
  );
}

/** 验证码行。 */
export interface VerificationCode {
  readonly id: string;
  readonly email: string;
  readonly purpose: VerificationPurpose;
  readonly attempts: number;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

export interface IssueCodeInput {
  readonly email: string;
  readonly purpose: VerificationPurpose;
  /** HMAC-SHA256 十六进制（64 字符）——不存明文，域外计算。 */
  readonly codeHash: string;
  readonly expiresAt: Date;
}

/** 核码失败的四态（安全事件按此分型，详设 §8.2 扩列）。 */
export type CodeFailureReason = 'invalid' | 'expired' | 'attempts_exhausted' | 'consumed';

export interface VerificationCodeRepository {
  /**
   * 发新码：**同事务先置同 (email,purpose) 旧码 `consumedAt`** 再插入——
   * 单活跃码规则（RD-012 §2.4），并行双码互扰的口子关死。
   */
  issue(input: IssueCodeInput): Promise<void>;

  /** 取当前活跃码（未消费、未过期）；无则 null。 */
  findActive(
    email: string,
    purpose: VerificationPurpose,
    now: Date,
  ): Promise<VerificationCode | null>;

  /**
   * 核码（一次性判定）：活跃码存在 → 比对哈希 → attempts<5 → 未过期 → 消费。
   *
   * 判定在**库侧同事务**完成，避免「读到活跃码—比对—消费」之间的并发双花。
   *
   * @returns 成功 null；失败给出四态原因（调用方统一文案 + 分型安全事件）。
   */
  consume(
    email: string,
    purpose: VerificationPurpose,
    codeHash: string,
    now: Date,
  ): Promise<CodeFailureReason | null>;

  /** 发码频控计数（每 email：5 次/小时、15 次/日——DB 窗口计数，重启不失效）。
   *  计数**跨 purpose 合并**：按 purpose 分桶会让攻击者用用途轮换绕过限流。 */
  countSince(email: string, since: Date): Promise<number>;
}

/** 验证码安全常量（终审确认口径，单点定义）。 */
export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
/** 发码频控：每 email 每小时上限 / 每日上限（RD-012 §4.2）。 */
export const CODE_SEND_LIMIT_PER_HOUR = 5;
export const CODE_SEND_LIMIT_PER_DAY = 15;

/**
 * 验证码的生成与哈希端口（AUTH-002，RD-012 §8.1）。
 *
 * 生成与哈希合在一处：两者都依赖密码学随机/密钥，拆成两个端口只会让
 * 用例多拿一个它不需要组装的依赖。
 *
 * - `generate` 必须**均匀**（`crypto.randomInt`，不是 `random` 取模——
 *   取模对 6 位十进制的低位有可测偏差）。
 * - `hash` 是 HMAC-SHA256（AUTH_SECRET 分域派生，消息＝`purpose|email|code`）——
 *   **不存明文**，库泄露 ≠ 码泄露；比对在库侧以 `consume` 的原子判定完成。
 */
export interface VerificationCodeCrypto {
  /** 生成 `CODE_LENGTH` 位十进制码。 */
  generate(): string;
  /** 计算落库哈希（十六进制 64 字符）。 */
  hash(input: { email: string; purpose: VerificationPurpose; code: string }): string;
}
