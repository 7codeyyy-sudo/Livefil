/**
 * 注册（PD-029 拍板「1+2」：免邮箱验证 + 邀请码制；原《接口文档》v0.8 #2 经
 * PD-029 勘误）。
 *
 * ## 顺序即安全
 *
 * 1. **IP 限流**（免验证后注册防滥用的第一闸，原修正条 L108 主体保留）；
 * 2. **邀请码门**（PD-029 第 2 项：码门＝第二闸；无码/错码统一文案防枚举）；
 * 3. **邮箱验证（双态）**——`emailEnabled`（＝`EMAIL_API_URL` 已配置）为真时
 *    要求 `email + code` 并**真核码**（原三步注册的验证能力随邮件通道回归，
 *    拍板 3）；为假（降级态）时 email 选填、免核码、`emailVerifiedAt` 恒 null。
 * 4. **identifier 相同检查**（B1 定稿：密码不得与邮箱/账号全文相同）；
 * 5. 建号（单事务：用户 + 播种）→ 建会话（会话固定防护）。
 *
 * ## 免验证后防滥用职责的移交（PD-029 第 5 项）
 *
 * 降级态下原「验证码门槛」的注册防滥用职责，移交**邀请码门（码熵）+ IP 限流**
 * 双闸。核码路径保留在本用例（全形态双态启用），验证码登录/重置/改邮箱的核码
 * 通道不动（主体零回归）。
 *
 * ## 码失败为什么统一文案
 *
 * 邀请码「没提供码/码为空/不匹配」与核码「过期/错验/不存在」都回同一条 400
 * 文案——区分它们等于给枚举者一台「码状态 oracle」（防枚举纪律）。差异只进
 * 安全事件。
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
import { CODE_INVALID_MESSAGE } from './credential-operations.ts';
import { RATE_LIMITED_MESSAGE } from './send-verification-code.ts';

/**
 * 统一邀请码失败文案（PD-029 第 2 项：无码/错码同一句防枚举）。
 *
 * schema 层只校验「给了就必须是字符串」，缺失与错码都到本用例判——于是
 * 「没提供」与「提供但不对」**共用这一句**，枚举者分不出失败类型。
 */
export const INVITE_CODE_INVALID_MESSAGE = '邀请码不正确。';

/** 全形态下缺邮箱验证字段的 400 文案（emailEnabled 双态；PD-029 第 3 项）。 */
export const REGISTER_EMAIL_REQUIRED_MESSAGE = '请填写邮箱并完成验证。';

export interface RegisterUserInput {
  /** 邀请码（简版码门；缺失/空/错码统一文案）。 */
  readonly inviteCode: string | undefined;
  /** 邮箱（降级态选填、不验证；全形态必填并核码；schema 已归一小写）。 */
  readonly email: string | undefined;
  /** 邮箱验证码（全形态必填并核码；降级态忽略）。 */
  readonly code: string | undefined;
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
  /**
   * 邀请码白名单（PD-029 第 2 项）：**已归一**（trim+小写+滤空）的集合，
   * 由装配层从 `serverEnv.inviteCodes` 注入（env 解析单点归一）。
   */
  readonly inviteCodes: readonly string[];
  /**
   * 邮件通道是否启用（PD-029 第 3 项单一分支点，来自 `serverEnv.emailEnabled`）：
   * 真＝全形态（要求邮箱验证），假＝降级态（免验证）。
   */
  readonly emailEnabled: boolean;
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
  readonly #inviteCodes: readonly string[];
  readonly #emailEnabled: boolean;
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
    this.#inviteCodes = dependencies.inviteCodes;
    this.#emailEnabled = dependencies.emailEnabled;
    this.#now = dependencies.now ?? Date.now;
  }

  /**
   * 完成注册并直接签发会话（注册即登录；PD-029 勘误后的契约语义）。
   *
   * @throws {RateLimitError} 注册 IP 限流（429，双闸之一）。
   * @throws {ValidationError} 邀请码失败、全形态缺邮箱验证字段或核码失败
   *   （统一 400）、字段不合法。
   * @throws {ConflictError} email/username 唯一冲突（409，仓储翻译）。
   */
  async execute(input: RegisterUserInput): Promise<RegisterUserResult> {
    const nowMs = this.#now();

    // 闸一：IP 限流（免验证后注册滥用的第一道，原修正条 L108 主体保留）。
    if (
      !this.#rateLimiter.consume(
        'register:ip:' + input.ip,
        RATE_LIMITS.registerPerIp.limit,
        RATE_LIMITS.registerPerIp.windowMs,
      )
    ) {
      throw new RateLimitError(RATE_LIMITED_MESSAGE);
    }

    // 闸二：邀请码门（PD-029 第 2 项）。无码/错码统一文案（防枚举），
    // 失败只进安全事件，响应不区分类型。
    const normalizedInvite = (input.inviteCode ?? '').trim().toLowerCase();
    if (!this.#inviteCodes.includes(normalizedInvite)) {
      this.#audit.record({
        type: 'AUTH_REGISTER_FAILED',
        outcome: 'failed',
        anonymousUserId: null,
      });
      throw new ValidationError(INVITE_CODE_INVALID_MESSAGE);
    }

    // 邮箱验证（双态，PD-029 第 3 项）：全形态要求 email+code 并真核码；
    // 降级态免验证（email 选填）。emailVerifiedAt 随之双态（验证过才写时刻）。
    let emailVerifiedAt: Date | null = null;
    if (this.#emailEnabled) {
      if (input.email === undefined || input.code === undefined) {
        this.#audit.record({
          type: 'AUTH_REGISTER_FAILED',
          outcome: 'failed',
          anonymousUserId: null,
        });
        throw new ValidationError(REGISTER_EMAIL_REQUIRED_MESSAGE);
      }
      // 核码（一次性原子判定；四态只进安全事件，响应统一 400）。
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
      emailVerifiedAt = new Date(nowMs);
    }

    // B1 定稿：密码不得与 identifier（邮箱/账号）全文相同。邮箱选填——
    // 无邮箱用户只比账号（没有邮箱可比，不虚构判据）。
    if (
      input.password === input.username ||
      (input.email !== undefined && input.password === input.email)
    ) {
      throw new ValidationError('密码不能与邮箱或账号相同', {
        fields: { password: '不能与邮箱或账号相同' },
      });
    }

    // 建号 + 播种单事务（唯一冲突由仓储翻译为 409）。
    //
    // PD-029 免邮箱验证（降级态）：`emailVerifiedAt` 恒 `null`——没验证过就
    // 不写验证时刻（诚实优于填 now 冒充）；全形态核码通过才写。
    const passwordHash = await this.#passwordHasher.hash(input.password);
    const user = await this.#accounts.createCloudAccount(
      {
        email: input.email ?? null,
        username: input.username,
        displayName: input.displayName ?? null,
        passwordHash,
        emailVerifiedAt,
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
