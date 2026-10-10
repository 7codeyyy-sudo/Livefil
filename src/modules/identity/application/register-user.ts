/**
 * 注册（PD-029 拍板「1+2」：免邮箱验证 + 邀请码制；原《接口文档》v0.8 #2 经
 * PD-029 勘误——「邮箱→验证码」两步砍除）。
 *
 * ## 顺序即安全
 *
 * 1. **IP 限流**（免验证后注册防滥用的第一闸，原修正条 L108 主体保留）；
 * 2. **邀请码门**（PD-029 第 2 项：码门＝第二闸；无码/错码统一文案防枚举）；
 * 3. **identifier 相同检查**（B1 定稿：密码不得与邮箱/账号全文相同——
 *    跨字段约束，schema 看不见上下文，只能在这里判）；
 * 4. 建号（单事务：用户 + 播种默认领域；email 可空、`emailVerifiedAt` 恒 null）
 *    → 建会话（会话固定防护：新行新令牌）。
 *
 * ## 免验证后防滥用职责的移交（PD-029 第 5 项）
 *
 * 原「验证码门槛」承担的注册防滥用，移交**邀请码门（码熵）+ IP 限流**双闸。
 * 核码路径从本用例移除；验证码登录/重置/改邮箱的核码通道**不动**（主体零回归）。
 *
 * ## 邀请码失败为什么统一文案
 *
 * 「没提供码」「码为空」「码不匹配」三种失败回同一条 400 文案——区分它们等于
 * 给枚举者一台「邀请码状态 oracle」（同核码防枚举纪律）。差异只进安全事件。
 */
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import { RateLimitError, ValidationError } from '@/shared/errors/app-error.ts';

import type { AccountRepository } from '../domain/account-repository.ts';
import type { LifeAreaSeed } from '../../life-areas/domain/life-area.ts';
import type { RateLimiter } from '../domain/rate-limiter.ts';
import { RATE_LIMITS } from '../domain/rate-limiter.ts';
import type { PasswordHasher } from '../domain/password-hasher.ts';
import type { SessionTokenService } from '../domain/session-token.ts';
import type { SessionRepository } from '../domain/session.ts';
import { issueSession, type IssuedSession } from './issue-session.ts';
import { RATE_LIMITED_MESSAGE } from './send-verification-code.ts';

/**
 * 统一邀请码失败文案（PD-029 第 2 项：无码/错码同一句防枚举）。
 *
 * schema 层只校验「给了就必须是字符串」，缺失与错码都到本用例判——于是
 * 「没提供」与「提供但不对」**共用这一句**，枚举者分不出失败类型。
 */
export const INVITE_CODE_INVALID_MESSAGE = '邀请码不正确。';

export interface RegisterUserInput {
  /** 邀请码（简版码门；缺失/空/错码统一文案）。 */
  readonly inviteCode: string | undefined;
  /** 邮箱（PD-029：选填、不验证、不发信；schema 已归一小写）。 */
  readonly email: string | undefined;
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
  readonly now?: (() => number) | undefined;
}

export class RegisterUserUseCase {
  readonly #accounts: AccountRepository;
  readonly #passwordHasher: PasswordHasher;
  readonly #sessions: SessionRepository;
  readonly #signer: SessionTokenService;
  readonly #rateLimiter: RateLimiter;
  readonly #audit: AuditLogger;
  readonly #lifeAreaSeeds: readonly LifeAreaSeed[];
  readonly #inviteCodes: readonly string[];
  readonly #now: () => number;

  constructor(dependencies: RegisterUserDependencies) {
    this.#accounts = dependencies.accounts;
    this.#passwordHasher = dependencies.passwordHasher;
    this.#sessions = dependencies.sessions;
    this.#signer = dependencies.signer;
    this.#rateLimiter = dependencies.rateLimiter;
    this.#audit = dependencies.audit;
    this.#lifeAreaSeeds = dependencies.lifeAreaSeeds;
    this.#inviteCodes = dependencies.inviteCodes;
    this.#now = dependencies.now ?? Date.now;
  }

  /**
   * 完成注册并直接签发会话（注册即登录；PD-029 勘误后的契约语义）。
   *
   * @throws {RateLimitError} 注册 IP 限流（429，双闸之一）。
   * @throws {ValidationError} 邀请码失败（统一 400）或字段不合法。
   * @throws {ConflictError} email/username 唯一冲突（409，仓储翻译）。
   */
  async execute(input: RegisterUserInput): Promise<RegisterUserResult> {
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
    // PD-029 免邮箱验证：`emailVerifiedAt` 恒 `null`——没验证过就不写验证时刻
    // （诚实优于填 now 冒充）；邮箱选填（无邮箱用户靠 username 登录）。
    const passwordHash = await this.#passwordHasher.hash(input.password);
    const user = await this.#accounts.createCloudAccount(
      {
        email: input.email ?? null,
        username: input.username,
        displayName: input.displayName ?? null,
        passwordHash,
        emailVerifiedAt: null,
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
