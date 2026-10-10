/**
 * 注册（AUTH-002，《接口文档》v0.8 #2；RD-012 §3 流 1）。
 *
 * ## 顺序即安全
 *
 * 1. **IP 限流**（注册防滥用主体＝验证码门槛 + 本条，修正条 L108）；
 * 2. **核码**（一次性原子判定——过期/错验/超限由仓储分型，统一 400 文案）；
 * 3. **identifier 相同检查**（B1 定稿：密码不得与邮箱/账号全文相同——
 *    跨字段约束，schema 看不见上下文，只能在这里判）；
 * 4. 建号（单事务：用户 + 播种默认领域）→ 建会话（会话固定防护：新行新令牌）。
 *
 * ## 核码失败为什么不暴露原因
 *
 * 「过期」「错验」「不存在」三种失败统一回同一条 400 文案（契约 v0.8 #2）——
 * 区分它们等于给枚举者一台「验证码状态 oracle」。四态差异只进安全事件日志
 * （详设 §8.2 扩列），不进响应。
 */
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import { RateLimitError, ValidationError } from '@/shared/errors/app-error.ts';

import type { AccountRepository } from '../domain/account-repository.ts';
import type { LifeAreaSeed } from '../../life-areas/domain/life-area.ts';
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

/** 统一核码失败文案（契约 v0.8 #2；UI-010 C1 步 2 错误行同句）。 */
export const CODE_INVALID_MESSAGE = '验证码不正确或已过期。';

export interface RegisterUserInput {
  readonly email: string;
  readonly code: string;
  readonly username: string;
  readonly displayName: string | null | undefined;
  readonly password: string;
  readonly ip: string;
  readonly userAgent: string | null;
}

export interface RegisterUserResult {
  readonly userId: string;
  readonly session: IssuedSession;
}

export interface RegisterUserDependencies {
  readonly accounts: AccountRepository;
  readonly codes: VerificationCodeRepository;
  readonly crypto: VerificationCodeCrypto;
  readonly passwordHasher: PasswordHasher;
  readonly sessions: SessionRepository;
  readonly signer: SessionTokenService;
  readonly rateLimiter: RateLimiter;
  readonly audit: AuditLogger;
  /** 首启播种名单（与 ensureLocalUser 同源——注册不是「不播种」的理由）。 */
  readonly lifeAreaSeeds: readonly LifeAreaSeed[];
  readonly now?: (() => number) | undefined;
}

export class RegisterUserUseCase {
  readonly #accounts: AccountRepository;
  readonly #codes: VerificationCodeRepository;
  readonly #crypto: VerificationCodeCrypto;
  readonly #passwordHasher: PasswordHasher;
  readonly #sessions: SessionRepository;
  readonly #signer: SessionTokenService;
  readonly #rateLimiter: RateLimiter;
  readonly #audit: AuditLogger;
  readonly #lifeAreaSeeds: readonly LifeAreaSeed[];
  readonly #now: () => number;

  constructor(dependencies: RegisterUserDependencies) {
    this.#accounts = dependencies.accounts;
    this.#codes = dependencies.codes;
    this.#crypto = dependencies.crypto;
    this.#passwordHasher = dependencies.passwordHasher;
    this.#sessions = dependencies.sessions;
    this.#signer = dependencies.signer;
    this.#rateLimiter = dependencies.rateLimiter;
    this.#audit = dependencies.audit;
    this.#lifeAreaSeeds = dependencies.lifeAreaSeeds;
    this.#now = dependencies.now ?? Date.now;
  }

  /**
   * 完成注册并直接签发会话（注册即登录，契约 v0.8 #2）。
   *
   * @throws {RateLimitError} 注册 IP 限流（429）。
   * @throws {ValidationError} 核码失败（统一 400）或字段不合法。
   * @throws {ConflictError} email/username 唯一冲突（409，仓储翻译）。
   */
  async execute(input: RegisterUserInput): Promise<RegisterUserResult> {
    if (
      !this.#rateLimiter.consume(
        'register:ip:' + input.ip,
        RATE_LIMITS.registerPerIp.limit,
        RATE_LIMITS.registerPerIp.windowMs,
      )
    ) {
      throw new RateLimitError(RATE_LIMITED_MESSAGE);
    }

    // 核码（一次性原子判定）。四态只进安全事件，不进响应。
    const nowMs = this.#now();
    const codeHash = this.#crypto.hash({
      email: input.email,
      purpose: 'register',
      code: input.code,
    });
    const failure = await this.#codes.consume(input.email, 'register', codeHash, new Date(nowMs));
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
      this.#audit.record({
        type: 'AUTH_REGISTER_FAILED',
        outcome: 'failed',
        anonymousUserId: null,
      });
      throw new ValidationError(CODE_INVALID_MESSAGE);
    }
    this.#audit.record({
      type: 'AUTH_CODE_VERIFICATION_SUCCEEDED',
      outcome: 'succeeded',
      anonymousUserId: null,
    });

    // B1 定稿：密码不得与 identifier（邮箱/账号）全文相同。
    if (input.password === input.email || input.password === input.username) {
      throw new ValidationError('密码不能与邮箱或账号相同', {
        fields: { password: '不能与邮箱或账号相同' },
      });
    }

    // 建号 + 播种单事务（唯一冲突由仓储翻译为 409）。
    const passwordHash = await this.#passwordHasher.hash(input.password);
    const user = await this.#accounts.createCloudAccount(
      {
        email: input.email,
        username: input.username,
        displayName: input.displayName ?? null,
        passwordHash,
        emailVerifiedAt: new Date(this.#now()),
      },
      this.#lifeAreaSeeds,
    );

    // 注册即登录：新会话行 + 新令牌（会话固定防护——入站 sid 永不复用）。
    const session = await issueSession(
      { sessions: this.#sessions, signer: this.#signer, now: this.#now },
      { userId: user.id, userAgent: input.userAgent },
    );

    this.#audit.record({
      type: 'AUTH_REGISTER_SUCCEEDED',
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(user.id),
    });

    return { userId: user.id, session };
  }
}
