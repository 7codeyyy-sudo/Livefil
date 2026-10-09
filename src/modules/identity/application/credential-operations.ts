/**
 * 凭据操作三用例（AUTH-002，《接口文档》v0.8 #5/#6/#7/#8；RD-012 §3 流 6/7/8）。
 *
 * 吊销策略是这三者的分水岭（RD-012 §3 流 5 表）：
 * - **改密码**：吊销其余、**保留当前**（本人操作，不该把自己踢下线）；
 * - **重置密码**：**全量吊销含当前**（走到重置说明当前会话可能不属于本人——
 *   忘记密码流程无法验证当前会话，安全侧选择宁可多踢）；
 * - **改邮箱**：吊销其余、保留当前（同改密码——高风险双验证已过）。
 */
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import {
  AuthenticationError,
  ConflictError,
  RateLimitError,
  ValidationError,
} from '@/shared/errors/app-error.ts';

import type { AccountRepository } from '../domain/account-repository.ts';
import type { RateLimiter } from '../domain/rate-limiter.ts';
import { RATE_LIMITS } from '../domain/rate-limiter.ts';
import type {
  VerificationCodeCrypto,
  VerificationCodeRepository,
} from '../domain/verification-code.ts';
import { CODE_TTL_MS } from '../domain/verification-code.ts';
import type { PasswordHasher } from '../domain/password-hasher.ts';
import type { SessionRepository } from '../domain/session.ts';
import { CODE_INVALID_MESSAGE } from './register-user.ts';
import { RATE_LIMITED_MESSAGE } from './send-verification-code.ts';

/** 统一「当前密码不正确」文案（契约 v0.8 #6/#7/#8：401）。 */
export const CURRENT_PASSWORD_MESSAGE = '当前密码不正确。';

interface CredentialDeps {
  readonly accounts: AccountRepository;
  readonly passwordHasher: PasswordHasher;
  readonly sessions: SessionRepository;
  readonly audit: AuditLogger;
  readonly now?: (() => number) | undefined;
}

/**
 * 改密码（#6，已登录）：先验当前密码 → 新密码过 B1 规则 → 更新 → 吊销其余。
 */
export class ChangePasswordUseCase {
  readonly #accounts: AccountRepository;
  readonly #passwordHasher: PasswordHasher;
  readonly #sessions: SessionRepository;
  readonly #audit: AuditLogger;
  readonly #now: () => number;

  constructor(dependencies: CredentialDeps) {
    this.#accounts = dependencies.accounts;
    this.#passwordHasher = dependencies.passwordHasher;
    this.#sessions = dependencies.sessions;
    this.#audit = dependencies.audit;
    this.#now = dependencies.now ?? Date.now;
  }

  async execute(
    userId: string,
    currentSessionId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const account = await this.#accounts.findById(userId);
    if (account === null || account.passwordHash === null) {
      throw new AuthenticationError(CURRENT_PASSWORD_MESSAGE);
    }

    const ok = await this.#passwordHasher.verify(input.currentPassword, account.passwordHash);
    if (!ok) {
      this.#audit.record({
        type: 'AUTH_PASSWORD_CHANGED',
        outcome: 'failed',
        anonymousUserId: toAnonymousUserId(userId),
      });
      throw new AuthenticationError(CURRENT_PASSWORD_MESSAGE);
    }

    // B1 定稿：新密码不得与 identifier（邮箱/账号）全文相同。
    if (
      input.newPassword === account.email ||
      (account.username !== null && input.newPassword === account.username)
    ) {
      throw new ValidationError('密码不能与邮箱或账号相同', {
        fields: { newPassword: '不能与邮箱或账号相同' },
      });
    }

    const hash = await this.#passwordHasher.hash(input.newPassword);
    await this.#accounts.updatePasswordHash(userId, hash);
    // 吊销其余、保留当前（本用例头部的策略表）。
    await this.#sessions.revokeOthers(userId, currentSessionId, new Date(this.#now()));

    this.#audit.record({
      type: 'AUTH_PASSWORD_CHANGED',
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
    });
  }
}

export interface ResetPasswordDependencies extends CredentialDeps {
  readonly codes: VerificationCodeRepository;
  readonly crypto: VerificationCodeCrypto;
  readonly rateLimiter: RateLimiter;
}

/**
 * 重置密码（#5）：核码（统一 400）→ 更新 → **全量吊销含当前**。
 *
 * 已登录态访问本流程：允许、不拦截（RD-012 §9-B8）；完成后因全量吊销
 * 自然回到未登录。
 *
 * 限流（§14.1 重置族：每 email 5 次/小时）在**用例内**判定而不是路由层——
 * 依赖方向纪律：路由不得引用领域层（App Router 规则），而限流键的领域语义
 * （email 维度）本就属于本用例的输入面。
 */
export class ResetPasswordUseCase {
  readonly #accounts: AccountRepository;
  readonly #codes: VerificationCodeRepository;
  readonly #crypto: VerificationCodeCrypto;
  readonly #passwordHasher: PasswordHasher;
  readonly #sessions: SessionRepository;
  readonly #audit: AuditLogger;
  readonly #rateLimiter: RateLimiter;
  readonly #now: () => number;

  constructor(dependencies: ResetPasswordDependencies) {
    this.#accounts = dependencies.accounts;
    this.#codes = dependencies.codes;
    this.#crypto = dependencies.crypto;
    this.#passwordHasher = dependencies.passwordHasher;
    this.#sessions = dependencies.sessions;
    this.#audit = dependencies.audit;
    this.#rateLimiter = dependencies.rateLimiter;
    this.#now = dependencies.now ?? Date.now;
  }

  async execute(input: { email: string; code: string; newPassword: string }): Promise<void> {
    // 限流（§14.1 重置族）——IP 维度由发码端点已挡，本处挡「拿已泄露码反复提交」。
    if (
      !this.#rateLimiter.consume(
        'reset:email:' + input.email,
        RATE_LIMITS.passwordOps.limit,
        RATE_LIMITS.passwordOps.windowMs,
      )
    ) {
      throw new RateLimitError(RATE_LIMITED_MESSAGE);
    }

    const now = new Date(this.#now());
    const codeHash = this.#crypto.hash({
      email: input.email,
      purpose: 'password_reset',
      code: input.code,
    });
    const failure = await this.#codes.consume(input.email, 'password_reset', codeHash, now);
    if (failure !== null) {
      this.#audit.record({
        type:
          failure === 'expired'
            ? 'AUTH_CODE_EXPIRED'
            : failure === 'attempts_exhausted'
              ? 'AUTH_CODE_ATTEMPTS_EXHAUSTED'
              : 'AUTH_CODE_VERIFICATION_FAILED',
        outcome: 'failed',
        anonymousUserId: null,
      });
      throw new ValidationError(CODE_INVALID_MESSAGE);
    }

    const account = await this.#accounts.findByEmail(input.email);
    if (account === null) {
      // 码有效但账号刚消失（极端窗口）：对外仍是统一 400，不泄露状态。
      throw new ValidationError(CODE_INVALID_MESSAGE);
    }

    if (
      input.newPassword === input.email ||
      (account.username !== null && input.newPassword === account.username)
    ) {
      throw new ValidationError('密码不能与邮箱或账号相同', {
        fields: { newPassword: '不能与邮箱或账号相同' },
      });
    }

    const hash = await this.#passwordHasher.hash(input.newPassword);
    await this.#accounts.updatePasswordHash(account.userId, hash);
    // 全量吊销含当前（流 5 策略表：重置无法验证当前会话归属）。
    await this.#sessions.revokeAll(account.userId, now);

    this.#audit.record({
      type: 'AUTH_PASSWORD_RESET_SUCCEEDED',
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(account.userId),
    });
  }
}

export interface ChangeEmailDependencies extends CredentialDeps {
  readonly codes: VerificationCodeRepository;
  readonly crypto: VerificationCodeCrypto;
  readonly rateLimiter: RateLimiter;
}

/**
 * 改邮箱·发码（#7，双验证第一半）：验当前密码 → 频控 → 向**新**邮箱发码。
 *
 * 恒定 200 信封（防枚举）——新邮箱是否已注册的差异只在邮件侧（#8 才回 409）。
 */
export class SendChangeEmailCodeUseCase {
  readonly #accounts: AccountRepository;
  readonly #codes: VerificationCodeRepository;
  readonly #crypto: VerificationCodeCrypto;
  readonly #passwordHasher: PasswordHasher;
  readonly #sessions: SessionRepository;
  readonly #audit: AuditLogger;
  readonly #rateLimiter: RateLimiter;
  readonly #now: () => number;

  constructor(dependencies: ChangeEmailDependencies) {
    this.#accounts = dependencies.accounts;
    this.#codes = dependencies.codes;
    this.#crypto = dependencies.crypto;
    this.#passwordHasher = dependencies.passwordHasher;
    this.#sessions = dependencies.sessions;
    this.#audit = dependencies.audit;
    this.#rateLimiter = dependencies.rateLimiter;
    this.#now = dependencies.now ?? Date.now;
  }

  async execute(
    userId: string,
    input: { newEmail: string; currentPassword: string },
    send: (to: string, code: string) => Promise<void>,
  ): Promise<void> {
    const account = await this.#accounts.findById(userId);
    if (account === null || account.passwordHash === null) {
      throw new AuthenticationError(CURRENT_PASSWORD_MESSAGE);
    }
    const ok = await this.#passwordHasher.verify(input.currentPassword, account.passwordHash);
    if (!ok) {
      throw new AuthenticationError(CURRENT_PASSWORD_MESSAGE);
    }
    if (
      !this.#rateLimiter.consume(
        'change-email:user:' + userId,
        RATE_LIMITS.passwordOps.limit,
        RATE_LIMITS.passwordOps.windowMs,
      )
    ) {
      throw new RateLimitError(RATE_LIMITED_MESSAGE);
    }

    const nowMs = this.#now();
    const code = await this.#generateAndIssue(input.newEmail, 'change_email', new Date(nowMs));
    await send(input.newEmail, code);
  }

  /** 生成 + 落码（两用例共用）。 */
  async #generateAndIssue(email: string, purpose: 'change_email', now: Date): Promise<string> {
    const code = this.#crypto.generate();
    await this.#codes.issue({
      email,
      purpose,
      codeHash: this.#crypto.hash({ email, purpose, code }),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    });
    return code;
  }
}

export interface ChangeEmailSubmitDependencies extends CredentialDeps {
  readonly codes: VerificationCodeRepository;
  readonly crypto: VerificationCodeCrypto;
}

/**
 * 改邮箱·提交（#8，双验证第二半）：核码 + 再验当前密码 → 更新 → 吊销其余。
 */
export class ChangeEmailUseCase {
  readonly #accounts: AccountRepository;
  readonly #codes: VerificationCodeRepository;
  readonly #crypto: VerificationCodeCrypto;
  readonly #passwordHasher: PasswordHasher;
  readonly #sessions: SessionRepository;
  readonly #audit: AuditLogger;
  readonly #now: () => number;

  constructor(dependencies: ChangeEmailSubmitDependencies) {
    this.#accounts = dependencies.accounts;
    this.#codes = dependencies.codes;
    this.#crypto = dependencies.crypto;
    this.#passwordHasher = dependencies.passwordHasher;
    this.#sessions = dependencies.sessions;
    this.#audit = dependencies.audit;
    this.#now = dependencies.now ?? Date.now;
  }

  async execute(
    userId: string,
    currentSessionId: string,
    input: { newEmail: string; code: string; currentPassword: string },
  ): Promise<void> {
    const now = new Date(this.#now());

    const account = await this.#accounts.findById(userId);
    if (account === null || account.passwordHash === null) {
      throw new AuthenticationError(CURRENT_PASSWORD_MESSAGE);
    }
    const ok = await this.#passwordHasher.verify(input.currentPassword, account.passwordHash);
    if (!ok) {
      throw new AuthenticationError(CURRENT_PASSWORD_MESSAGE);
    }

    const codeHash = this.#crypto.hash({
      email: input.newEmail,
      purpose: 'change_email',
      code: input.code,
    });
    const failure = await this.#codes.consume(input.newEmail, 'change_email', codeHash, now);
    if (failure !== null) {
      this.#audit.record({
        type:
          failure === 'expired'
            ? 'AUTH_CODE_EXPIRED'
            : failure === 'attempts_exhausted'
              ? 'AUTH_CODE_ATTEMPTS_EXHAUSTED'
              : 'AUTH_CODE_VERIFICATION_FAILED',
        outcome: 'failed',
        anonymousUserId: toAnonymousUserId(userId),
      });
      throw new ValidationError(CODE_INVALID_MESSAGE);
    }

    // 新邮箱占用 → 409（本步已过双验证，持有有效码的请求给字段级提示不构成枚举）。
    const occupied = await this.#accounts.findByEmail(input.newEmail);
    if (occupied !== null) {
      throw new ConflictError('该邮箱已被占用。', { fields: { newEmail: '已被占用' } });
    }

    await this.#accounts.updateEmail(userId, input.newEmail, now);
    await this.#sessions.revokeOthers(userId, currentSessionId, now);

    this.#audit.record({
      type: 'AUTH_EMAIL_CHANGED',
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
    });
  }
}
