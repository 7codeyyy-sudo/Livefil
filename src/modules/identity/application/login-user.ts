/**
 * 登录（AUTH-002，《接口文档》v0.8 #3；RD-012 §3 流 2/3、§4.3、§4.4）。
 *
 * ## 单一标识判定规则
 *
 * `identifier` 含 `@` ⇒ 邮箱路径，否则 ⇒ username 路径——字符集设计
 * （账号不含 `@`）保证两路径零重叠，因此不需要「先查邮箱再兜底账号」的
 * 双查询（RD-012 §4.3：判定规则单一，测试矩阵减半）。
 *
 * ## 统一 401 是防枚举的核心
 *
 * 查无、密码错、账户异常、验证码失败四种原因**回同一条 401 文案**——
 * 区分它们等于给枚举者一台账号存在性 oracle（RD-012 §4.4 矩阵）。
 * 原因差异只进安全事件日志（SRS §6.7 登录成功/失败）。
 *
 * ## 会话固定防护
 *
 * 登录成功**无视入站 Cookie、必建新会话行 + 签发新令牌 + 覆盖 Set-Cookie**——
 * 攻击者预置的 sid 永远轮不到被升格（RD-012 §3 流 2 步 3）。
 */
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import { AuthenticationError, RateLimitError } from '@/shared/errors/app-error.ts';

import type { AccountRepository } from '../domain/account-repository.ts';
import type { RateLimiter } from '../domain/rate-limiter.ts';
import { RATE_LIMITS } from '../domain/rate-limiter.ts';
import type {
  VerificationCodeCrypto,
  VerificationCodeRepository,
} from '../domain/verification-code.ts';
import type { PasswordHasher } from '../domain/password-hasher.ts';
import type { SessionTokenService } from '../domain/session-token.ts';
import type { SessionRepository } from '../domain/session.ts';
import { issueSession, type IssuedSession } from './issue-session.ts';
import { RATE_LIMITED_MESSAGE } from './send-verification-code.ts';

/** 统一登录失败文案（契约 v0.8 #3；UI-010 C2 冻结句同文）。 */
export const LOGIN_FAILED_MESSAGE = '邮箱/账号或密码不正确。';

export interface LoginUserInput {
  readonly identifier: string;
  /** 与 `code` 互斥二选一（schema 已保证恰有一个）。 */
  readonly password?: string | undefined;
  readonly code?: string | undefined;
  readonly ip: string;
  readonly userAgent: string | null;
}

export interface LoginUserResult {
  readonly userId: string;
  readonly session: IssuedSession;
}

export interface LoginUserDependencies {
  readonly accounts: AccountRepository;
  readonly codes: VerificationCodeRepository;
  readonly crypto: VerificationCodeCrypto;
  readonly passwordHasher: PasswordHasher;
  readonly sessions: SessionRepository;
  readonly signer: SessionTokenService;
  readonly rateLimiter: RateLimiter;
  readonly audit: AuditLogger;
  readonly now?: (() => number) | undefined;
}

export class LoginUserUseCase {
  readonly #accounts: AccountRepository;
  readonly #codes: VerificationCodeRepository;
  readonly #crypto: VerificationCodeCrypto;
  readonly #passwordHasher: PasswordHasher;
  readonly #sessions: SessionRepository;
  readonly #signer: SessionTokenService;
  readonly #rateLimiter: RateLimiter;
  readonly #audit: AuditLogger;
  readonly #now: () => number;

  constructor(dependencies: LoginUserDependencies) {
    this.#accounts = dependencies.accounts;
    this.#codes = dependencies.codes;
    this.#crypto = dependencies.crypto;
    this.#passwordHasher = dependencies.passwordHasher;
    this.#sessions = dependencies.sessions;
    this.#signer = dependencies.signer;
    this.#rateLimiter = dependencies.rateLimiter;
    this.#audit = dependencies.audit;
    this.#now = dependencies.now ?? Date.now;
  }

  /**
   * 双通道登录（成功签发会话；失败一律 401 统一文案）。
   *
   * @throws {RateLimitError} identifier 或 IP 限流（429）。
   * @throws {AuthenticationError} 任何凭据失败（**同一文案**，401）。
   */
  async execute(input: LoginUserInput): Promise<LoginUserResult> {
    // 双维限流：identifier 挡定向爆破，IP 挡横向扫描（契约 §14.1 登录族）。
    if (
      !this.#rateLimiter.consume(
        'login:id:' + input.identifier,
        RATE_LIMITS.loginPerIdentifier.limit,
        RATE_LIMITS.loginPerIdentifier.windowMs,
      ) ||
      !this.#rateLimiter.consume(
        'login:ip:' + input.ip,
        RATE_LIMITS.loginPerIp.limit,
        RATE_LIMITS.loginPerIp.windowMs,
      )
    ) {
      throw new RateLimitError(RATE_LIMITED_MESSAGE);
    }

    // 单一判定：含 @ 走邮箱，否则走账号（RD-012 §4.3）。
    const isEmail = input.identifier.includes('@');
    const account = isEmail
      ? await this.#accounts.findByEmail(input.identifier)
      : await this.#accounts.findByUsername(input.identifier);

    // 查无 / 非云端账号 / 无凭据：统一 401（不区分原因——防枚举）。
    if (account === null || account.passwordHash === null) {
      this.#audit.record({
        type: 'AUTH_LOGIN_FAILED',
        outcome: 'failed',
        anonymousUserId: null,
      });
      throw new AuthenticationError(LOGIN_FAILED_MESSAGE);
    }

    if (input.password !== undefined) {
      const ok = await this.#passwordHasher.verify(input.password, account.passwordHash);
      if (!ok) {
        this.#audit.record({
          type: 'AUTH_LOGIN_FAILED',
          outcome: 'failed',
          anonymousUserId: toAnonymousUserId(account.userId),
        });
        throw new AuthenticationError(LOGIN_FAILED_MESSAGE);
      }
    } else if (input.code !== undefined) {
      // 验证码通道：核码失败同样映射为统一 401（而不是 400）——
      // 登录面的失败语义只有一条（契约 v0.8 #3），四态差异进安全事件。
      //
      // 无邮箱用户没有验证码通道（PD-029 免邮箱验证注册可无邮箱，收不到信）：
      // 归一到与「密码错」同一条 401，不泄露「该账号无邮箱」这一事实。
      // 既有有邮箱 cloud 用户不进此分支，行为零变。
      if (account.email === null) {
        this.#audit.record({
          type: 'AUTH_LOGIN_FAILED',
          outcome: 'failed',
          anonymousUserId: toAnonymousUserId(account.userId),
        });
        throw new AuthenticationError(LOGIN_FAILED_MESSAGE);
      }
      const codeHash = this.#crypto.hash({
        email: account.email,
        purpose: 'login',
        code: input.code,
      });
      const failure = await this.#codes.consume(
        account.email,
        'login',
        codeHash,
        new Date(this.#now()),
      );
      if (failure !== null) {
        this.#audit.record({
          type:
            failure === 'expired'
              ? 'AUTH_CODE_EXPIRED'
              : failure === 'attempts_exhausted'
                ? 'AUTH_CODE_ATTEMPTS_EXHAUSTED'
                : 'AUTH_CODE_VERIFICATION_FAILED',
          outcome: 'failed',
          anonymousUserId: toAnonymousUserId(account.userId),
        });
        this.#audit.record({
          type: 'AUTH_LOGIN_FAILED',
          outcome: 'failed',
          anonymousUserId: toAnonymousUserId(account.userId),
        });
        throw new AuthenticationError(LOGIN_FAILED_MESSAGE);
      }
    }

    // 成功：新会话行 + 新令牌（会话固定防护——入站 sid 永不复用）。
    const session = await issueSession(
      { sessions: this.#sessions, signer: this.#signer, now: this.#now },
      { userId: account.userId, userAgent: input.userAgent },
    );

    this.#audit.record({
      type: 'AUTH_LOGIN_SUCCEEDED',
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(account.userId),
    });

    return { userId: account.userId, session };
  }
}
