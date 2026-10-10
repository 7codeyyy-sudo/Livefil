/**
 * 发送验证码（AUTH-002，《接口文档》v0.8 #1；RD-012 §3 流 1/3 步 1、§4.4）。
 *
 * ## 恒定响应是本用例的骨架
 *
 * 无论邮箱是否存在、purpose 是否可满足，API 侧**一律成功返回**——差异只允许
 * 出现在邮件内容里（收件人即邮箱主人，不构成对外枚举，RD-012 §4.4 矩阵）。
 * 用例因此**不返回任何分流信息**，路由层的响应体恒为 `{ sent: true }`。
 *
 * ## 双层频控
 *
 * - **IP 层**（进程内窗口）：挡单源扫描——20 次/小时。
 * - **email 层**（DB 窗口计数，跨 purpose 合并）：挡对单账号的定向轰炸——
 *   5 次/时、15 次/日；DB 计数重启不失效。
 *
 * 登录 purpose 的标识可为账号（UI-010 C2 单框）：服务端解析出邮箱再发码，
 * 解析结果不回传（RD-012 §3 流 3）。
 */
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { RateLimitError } from '@/shared/errors/app-error.ts';

import type { AccountRepository } from '../domain/account-repository.ts';
import type { EmailSender } from '../domain/email-sender.ts';
import type { RateLimiter } from '../domain/rate-limiter.ts';
import { RATE_LIMITS } from '../domain/rate-limiter.ts';
import type {
  VerificationCodeCrypto,
  VerificationCodeRepository,
} from '../domain/verification-code.ts';
import {
  CODE_SEND_LIMIT_PER_DAY,
  CODE_SEND_LIMIT_PER_HOUR,
  CODE_TTL_MS,
} from '../domain/verification-code.ts';

/** 统一限流文案（契约 §14.1，UI 冻结候选同句）。 */
export const RATE_LIMITED_MESSAGE = '操作过于频繁，请稍后再试。';

export interface SendVerificationCodeInput {
  /** 归一后的邮箱或账号（schema 已按 purpose 校验格式）。 */
  readonly identifier: string;
  readonly purpose: 'register' | 'login' | 'password_reset';
  /** 客户端 IP（限流维度）；未知时为 'unknown'。 */
  readonly ip: string;
}

export interface SendVerificationCodeDependencies {
  readonly accounts: AccountRepository;
  readonly codes: VerificationCodeRepository;
  readonly crypto: VerificationCodeCrypto;
  readonly email: EmailSender;
  readonly rateLimiter: RateLimiter;
  readonly audit: AuditLogger;
  readonly now?: (() => number) | undefined;
}

export class SendVerificationCodeUseCase {
  readonly #accounts: AccountRepository;
  readonly #codes: VerificationCodeRepository;
  readonly #crypto: VerificationCodeCrypto;
  readonly #email: EmailSender;
  readonly #rateLimiter: RateLimiter;
  readonly #audit: AuditLogger;
  readonly #now: () => number;

  constructor(dependencies: SendVerificationCodeDependencies) {
    this.#accounts = dependencies.accounts;
    this.#codes = dependencies.codes;
    this.#crypto = dependencies.crypto;
    this.#email = dependencies.email;
    this.#rateLimiter = dependencies.rateLimiter;
    this.#audit = dependencies.audit;
    this.#now = dependencies.now ?? Date.now;
  }

  /**
   * 发码（恒定成功；失败只有 400 格式错与 429 限流）。
   *
   * @throws {RateLimitError} IP 或 email 窗口超限（429 统一文案）。
   */
  async execute(input: SendVerificationCodeInput): Promise<void> {
    // 第一层：IP——最便宜的判定放最前，扫描流量不碰库。
    if (
      !this.#rateLimiter.consume(
        'code:ip:' + input.ip,
        RATE_LIMITS.codeSendPerIp.limit,
        RATE_LIMITS.codeSendPerIp.windowMs,
      )
    ) {
      throw new RateLimitError(RATE_LIMITED_MESSAGE);
    }

    // 解析目标邮箱：登录 purpose 的标识可为账号（服务端解析、结果不回传）。
    const email = await this.#resolveEmail(input);

    // 第二层：email 窗口（DB 计数，跨 purpose——用途轮换绕不过）。
    const nowMs = this.#now();
    const hourCount = await this.#codes.countSince(email, new Date(nowMs - 60 * 60 * 1000));
    if (hourCount >= CODE_SEND_LIMIT_PER_HOUR) {
      throw new RateLimitError(RATE_LIMITED_MESSAGE);
    }
    const dayCount = await this.#codes.countSince(email, new Date(nowMs - 24 * 60 * 60 * 1000));
    if (dayCount >= CODE_SEND_LIMIT_PER_DAY) {
      throw new RateLimitError(RATE_LIMITED_MESSAGE);
    }

    await this.#deliver(input, email);
  }

  /** 存在性分流与实际发信（只影响邮件内容，不影响 API 响应）。 */
  async #deliver(input: SendVerificationCodeInput, email: string): Promise<void> {
    const account = await this.#accounts.findByEmail(email);

    if (input.purpose === 'register' && account !== null) {
      await this.#email.sendAccountNotice({ to: email, kind: 'already_registered' });
      return;
    }
    if (input.purpose !== 'register' && account === null) {
      // 登录/重置遇未注册邮箱：重置发「未注册」提示信，登录不发码（无邮箱可发）。
      if (input.purpose === 'password_reset') {
        await this.#email.sendAccountNotice({ to: email, kind: 'not_registered' });
      }
      return;
    }

    const code = this.#crypto.generate();
    await this.#codes.issue({
      email,
      purpose: input.purpose,
      codeHash: this.#crypto.hash({ email: email, purpose: input.purpose, code: code }),
      expiresAt: new Date(this.#now() + CODE_TTL_MS),
    });
    await this.#email.sendVerificationCode({ to: email, code, purpose: input.purpose });

    if (input.purpose === 'password_reset') {
      // SRS §6.7 扩列注记：「密码重置**请求**」——请求成功发出即记，完成另记。
      this.#audit.record({
        type: 'AUTH_PASSWORD_RESET_REQUESTED',
        outcome: 'succeeded',
        anonymousUserId: null,
      });
    }
  }

  /** 标识 → 邮箱（登录 purpose 走账号解析；解析不回传，防 username→email 枚举）。 */
  async #resolveEmail(input: SendVerificationCodeInput): Promise<string> {
    if (input.purpose === 'login' && !input.identifier.includes('@')) {
      const account = await this.#accounts.findByUsername(input.identifier);
      // 查无该账号、或该账号无邮箱（PD-029 免验证注册可无邮箱）：都返回恒不发码
      // 的占位（API 仍恒 200，不泄露账号是否存在、也不泄露它有没有邮箱）。
      return account === null || account.email === null ? '' : account.email;
    }
    return input.identifier;
  }
}
