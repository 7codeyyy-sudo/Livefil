/**
 * 确保会话（IAM-001 本地语义 + AUTH-002 认证部署门禁，《详细设计》§4.6/§8.1，
 * RD-012 §5.2——**验收红线本体**）。
 *
 * ## 两种部署形态，互斥生效，同一代码
 *
 * - **`local`（缺省，逐字节维持 IAM-001 现状）**：无论请求带来什么（没有
 *   Cookie / 坏 Cookie / 指向已消失用户的 Cookie），都让它带着一个**可用的**
 *   本地会话离开，并保证本地用户与默认领域就绪——本地单用户没有"登录"这个
 *   动作可做，返回 401 等于要求用户去做一件不存在的事（FR-001 L170/L178）。
 * - **`cloud`（认证部署，验收红线）**：**关闭自动本地会话**——无/坏/过期/
 *   已吊销会话一律 `AuthenticationError`（401 `AUTHENTICATION_REQUIRED`，
 *   前端据此跳登录页）；有效会话则校验链 + 滑动续期。
 *
 * 判据来自 `APP_MODE`（env，缺省 local）：开发、CI、本地自用部署零配置即
 * 走 local 分支——「本地自用部署不受影响」的四判据之一（RD-012 §5.4）。
 *
 * ## cloud 分支的校验链（RD-012 §3 流 4）
 *
 * 验签（快拒伪造、不打库）→ `sessionId` 查行（uid 双谓词）→ 行状态权威
 * （`revoked_at`/`expires_at`）→ 半衰点滑动续期（重发 Cookie）→ `last_seen`
 * 节流记录。任何一环失败 = 401，**不重建、不静默降级**。
 */
import type { LifeAreaSeed } from '../../life-areas/domain/life-area.ts';
import type { SessionTokenService } from '../domain/session-token.ts';
import type { UserMode } from '../domain/user.ts';
import type { UserRepository } from '../domain/user-repository.ts';
import type { SessionRepository, CloudSessionPayload } from '../domain/session.ts';
import { AuthenticationError, InvariantError } from '@/shared/errors/app-error.ts';

export interface EnsureLocalSessionInput {
  /** 请求携带的会话令牌（`null` 表示没有或读取不到）。 */
  readonly sessionToken: string | null;
}

export interface EnsureLocalSessionResult {
  readonly userId: string;
  readonly mode: UserMode;
  /**
   * 需要下发的新令牌；`null` 表示请求携带的令牌仍然有效、不必重设 Cookie。
   *
   * cloud 分支的**滑动续期**也走本字段：半衰点续期后重签令牌，调用方据此
   * 重发 `Set-Cookie`（maxAge 同步顺延）——续期与首次签发同一出口，
   * 调用方无须区分两条路径。
   */
  readonly issuedToken: string | null;
  /** 本次调用是否创建了用户（日志与测试用；cloud 分支恒 false）。 */
  readonly created: boolean;
  /** cloud 分支的当前会话 id（登出/改密"保留当前"需要）；local 分支恒 null。 */
  readonly sessionId: string | null;
}

export interface EnsureLocalSessionDependencies {
  readonly users: UserRepository;
  readonly signer: SessionTokenService;
  /** 首启播种的领域名单（归 `life-areas` 领域）。 */
  readonly lifeAreaSeeds: readonly LifeAreaSeed[];
  /** 部署形态（AUTH-002 门禁判据）。缺省 `local`——既有调用点零改动。 */
  readonly mode?: 'local' | 'cloud' | undefined;
  /** 会话仓储；`mode=cloud` 时必填（缺配置＝装配错误，InvariantError）。 */
  readonly sessions?: SessionRepository | undefined;
  /** 时间源，便于测试固定签发时间。 */
  readonly now?: (() => number) | undefined;
}

export class EnsureLocalSessionUseCase {
  readonly #users: UserRepository;
  readonly #signer: SessionTokenService;
  readonly #lifeAreaSeeds: readonly LifeAreaSeed[];
  readonly #mode: 'local' | 'cloud';
  readonly #sessions: SessionRepository | undefined;
  readonly #now: () => number;

  constructor(dependencies: EnsureLocalSessionDependencies) {
    this.#users = dependencies.users;
    this.#signer = dependencies.signer;
    this.#lifeAreaSeeds = dependencies.lifeAreaSeeds;
    this.#mode = dependencies.mode ?? 'local';
    this.#sessions = dependencies.sessions;
    this.#now = dependencies.now ?? (() => Date.now());

    // 装配期自检（§8.3 分层必填）：cloud 形态缺会话仓储是配置错误，
    // 必须在启动/构造时暴露，而不是等第一个请求才炸。
    if (this.#mode === 'cloud' && this.#sessions === undefined) {
      throw new InvariantError({
        message: '认证部署（APP_MODE=cloud）缺少会话仓储依赖',
      });
    }
  }

  async execute(input: EnsureLocalSessionInput): Promise<EnsureLocalSessionResult> {
    if (this.#mode === 'cloud') {
      return this.#executeCloud(input);
    }
    return this.#executeLocal(input);
  }

  // ---------------------------------------------------------------- local
  //
  // 本分支的逻辑自 IAM-001 起**逐字节未动**：判据（签名有效 + 用户在库 ⇒ 复用；
  // 否则重建）与幂等语义（并发首启唯一用户由 schema 部分唯一索引兜住）保持原样。

  async #executeLocal(input: EnsureLocalSessionInput): Promise<EnsureLocalSessionResult> {
    if (input.sessionToken !== null) {
      const payload = this.#signer.verify(input.sessionToken);

      if (payload !== null) {
        // 签名有效不等于用户还在：库可能是重建过的（本地开发很常见）。
        // 确认存在再复用，否则会发出一个指向不存在用户的会话——那种会话在
        // 后续查询里表现为"到处查不到数据"，比直接重新初始化难查得多。
        const user = await this.#users.findById(payload.userId);
        if (user !== null) {
          return {
            userId: user.id,
            mode: user.mode,
            issuedToken: null,
            created: false,
            sessionId: null,
          };
        }
      }
    }

    const { user, created } = await this.#users.ensureLocalUser(this.#lifeAreaSeeds);

    return {
      userId: user.id,
      mode: user.mode,
      issuedToken: this.#signer.sign({ userId: user.id, issuedAt: this.#now() }),
      created,
      sessionId: null,
    };
  }

  // ---------------------------------------------------------------- cloud
  /** 认证部署：关闭自动本地会话，校验链失败一律 401（验收红线）。 */
  async #executeCloud(input: EnsureLocalSessionInput): Promise<EnsureLocalSessionResult> {
    const sessions = this.#sessions;
    if (sessions === undefined) {
      // 构造期已拦；此处为类型收窄而留，不可达。
      throw new InvariantError({ message: '认证部署缺少会话仓储依赖' });
    }

    // 1. 无 Cookie / 验签失败（快拒伪造、不打库）⇒ 401。
    if (input.sessionToken === null) {
      throw new AuthenticationError('需要登录后继续');
    }
    const payload = this.#signer.verify(input.sessionToken);
    if (payload === null || !isCloudPayload(payload)) {
      // 本地形态的令牌（无 sessionId）在认证部署下无效——两种形态的 Cookie
      // 不互认，避免"本地令牌在云端被升格"的形态混用。
      throw new AuthenticationError('需要登录后继续');
    }

    const nowMs = this.#now();
    const now = new Date(nowMs);

    // 2. 行状态权威：sid+uid 双谓词查行，不存在/已吊销/已过期 ⇒ 401。
    const session = await sessions.findByIdForUser(payload.sessionId, payload.userId);
    if (session === null || session.revokedAt !== null || session.expiresAt.getTime() <= nowMs) {
      throw new AuthenticationError('登录已过期，请重新登录');
    }

    // 3. 用户在库校验（软删账户的拒绝归 data-management 批接线，RD-012 §2.1）。
    const user = await this.#users.findById(payload.userId);
    if (user === null) {
      throw new AuthenticationError('需要登录后继续');
    }

    // 4. 半衰点滑动续期：发生续期 ⇒ 重签令牌（调用方重发 Set-Cookie）。
    const renewed = await sessions.renewIfDue(session.id, session.userId, now);
    if (renewed !== null) {
      const issuedToken = this.#signer.sign({
        userId: renewed.userId,
        sessionId: renewed.id,
        issuedAt: nowMs,
        exp: renewed.expiresAt.getTime(),
      });
      return {
        userId: user.id,
        mode: user.mode,
        issuedToken,
        created: false,
        sessionId: renewed.id,
      };
    }

    // 5. 活动记录（节流 ≥5 分钟在库侧 WHERE 判定，不产生每请求写）。
    await sessions.touch(session.id, session.userId, now);

    return {
      userId: user.id,
      mode: user.mode,
      issuedToken: null,
      created: false,
      sessionId: session.id,
    };
  }
}

/** 令牌形状判定：cloud 载荷必须携带 `sessionId` 与 `exp`（RD-012 §8.2）。 */
function isCloudPayload(payload: {
  readonly userId: string;
  readonly issuedAt: number;
}): payload is CloudSessionPayload {
  const candidate = payload as Partial<CloudSessionPayload>;
  return (
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId !== '' &&
    typeof candidate.exp === 'number' &&
    Number.isFinite(candidate.exp)
  );
}
