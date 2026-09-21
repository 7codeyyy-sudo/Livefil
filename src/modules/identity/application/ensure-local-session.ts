/**
 * 确保本地会话（IAM-001，《详细设计说明书》§4.6）。
 *
 * ## 这个用例的全部职责
 *
 * 「无论请求带来什么（没有 Cookie / 坏 Cookie / 指向已消失用户的 Cookie），
 * 都让它带着一个**可用的**本地会话离开，并保证本地用户与默认领域已就绪。」
 *
 * ## 为什么不返回 401
 *
 * §4.6 明确：本地模式**不产生 `AUTHENTICATION_REQUIRED`**——那个错误码只服务
 * 云端模式（挂账）。理由很实际：本地单用户没有"登录"这个动作可做，返回 401
 * 等于要求用户去做一件不存在的事。核心功能必须在无 Cookie 时也能用（SRS
 * NFR-REL-003 的弱网/离线口径同样指向这个方向）。
 *
 * ## 幂等
 *
 * 并发首启只产生一个用户、默认领域只播种一次（判据是"该用户一行领域都没有"，
 * 见 `default-life-areas.ts`）。仓储侧由唯一索引兜住，本层只依赖它的结果。
 */
import type { LifeAreaSeed } from '../../life-areas/domain/life-area.ts';
import type { SessionTokenService } from '../domain/session-token.ts';
import type { UserMode } from '../domain/user.ts';
import type { UserRepository } from '../domain/user-repository.ts';

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
   * 用"要不要下发"而不是"下发什么"来表达，是为了让调用方无法忘记这一分支：
   * 每次请求都重设 Cookie 会让响应带上无意义的 `Set-Cookie`，而漏设则会让
   * 首次访问的会话永远建立不起来。
   */
  readonly issuedToken: string | null;
  /** 本次调用是否创建了用户（日志与测试用）。 */
  readonly created: boolean;
}

export interface EnsureLocalSessionDependencies {
  readonly users: UserRepository;
  readonly signer: SessionTokenService;
  /** 首启播种的领域名单（归 `life-areas` 领域）。 */
  readonly lifeAreaSeeds: readonly LifeAreaSeed[];
  /** 时间源，便于测试固定签发时间。 */
  readonly now?: (() => number) | undefined;
}

export class EnsureLocalSessionUseCase {
  readonly #users: UserRepository;
  readonly #signer: SessionTokenService;
  readonly #lifeAreaSeeds: readonly LifeAreaSeed[];
  readonly #now: () => number;

  constructor(dependencies: EnsureLocalSessionDependencies) {
    this.#users = dependencies.users;
    this.#signer = dependencies.signer;
    this.#lifeAreaSeeds = dependencies.lifeAreaSeeds;
    this.#now = dependencies.now ?? (() => Date.now());
  }

  async execute(input: EnsureLocalSessionInput): Promise<EnsureLocalSessionResult> {
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
    };
  }
}
