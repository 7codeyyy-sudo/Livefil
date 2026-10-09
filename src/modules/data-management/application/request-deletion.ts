/**
 * 账户删除请求用例（OPS-002，《接口文档》§13 删除面；八定值：撤销窗 7 天、
 * 限流 3 次/天/用户、`cancel` 端点随批）。
 *
 * ## 跨批端口方向：data-management → identity
 *
 * 「发起即吊销该用户全部会话」经 identity 的 `SessionRepository.revokeAll`
 * 端口完成（RD-012 §2.1 契约面声明；批 A 已先立签名）。本模块不建 HTTP 端点
 * 指向 identity——组合根把仓储注进来，用例层只看端口。
 *
 * ## 本地部署下的行为
 *
 * 本地模式没有 `sessions` 行（无状态 HMAC Cookie），`revokeAll` 是自然空操作；
 * 删除请求本身在两种形态语义一致（7 天窗口 + 可撤销）。清理执行由
 * `scripts/purge-deletions.mjs` 到期扫描（cron 接线归批 3 OPS-006）。
 */
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';

import type { DeletionRequestRepository, RateLimiter } from '../domain/data-ports.ts';
import { DAY_MS, DELETION_WINDOW_DAYS, RATE_LIMITS } from '../domain/limits.ts';
import { enforceLimit } from './rate-guard.ts';

/** 契约未定义响应体形状——实现取最小三字段（RD-015 披露提请追认）。 */
export interface DeletionRequestResult {
  readonly status: 'pending';
  readonly requestedAt: string;
  readonly purgeAt: string;
}

/** 撤销响应（契约「200 幂等」——`cancelled` 表示本次是否真撤销了活跃请求）。 */
export interface DeletionCancelResult {
  readonly cancelled: boolean;
}

/** identity 会话端口的最小子集（方向：data-management → identity，仅签名依赖）。 */
export interface SessionRevokePort {
  revokeAll(userId: string, now: Date): Promise<void>;
}

export interface DeletionUseCaseDeps {
  readonly deletionRequests: DeletionRequestRepository;
  readonly sessions: SessionRevokePort;
  readonly limiter: RateLimiter;
  readonly audit: AuditLogger;
  readonly now: () => Date;
}

/** 发起账户删除（限流 3 次/天/用户；活跃期间重复发起幂等返回既有行）。 */
export class RequestAccountDeletionUseCase {
  readonly #deps: DeletionUseCaseDeps;

  constructor(deps: DeletionUseCaseDeps) {
    this.#deps = deps;
  }

  async execute(userId: string): Promise<DeletionRequestResult> {
    const { deletionRequests, sessions, limiter, audit, now } = this.#deps;
    enforceLimit(limiter, 'deletion', userId, RATE_LIMITS.deletionPerDay, DAY_MS);

    const requestedAt = now();
    const active = await deletionRequests.getActive(userId, requestedAt);
    if (active !== null) {
      // 活跃期间重复发起：返回既有 pending（幂等——窗口与期限不重置、不叠行，
      // 也不重复吊销）。语义实现面，RD-015 披露。
      return {
        status: 'pending',
        requestedAt: active.requestedAt.toISOString(),
        purgeAt: active.purgeAt.toISOString(),
      };
    }

    const purgeAt = new Date(requestedAt.getTime() + DELETION_WINDOW_DAYS * DAY_MS);
    const created = await deletionRequests.request(userId, requestedAt, purgeAt);
    // 契约：发起即吊销全部会话（安全事件 + 跨批端口，方向 data-management → identity）。
    await sessions.revokeAll(userId, requestedAt);
    audit.record({
      type: 'ACCOUNT_DELETION_REQUESTED',
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
    });

    return {
      status: 'pending',
      requestedAt: created.requestedAt.toISOString(),
      purgeAt: created.purgeAt.toISOString(),
    };
  }
}

/** 撤销删除请求（窗口内；200 幂等——无活跃请求也回 200）。 */
export class CancelAccountDeletionUseCase {
  readonly #deps: DeletionUseCaseDeps;

  constructor(deps: DeletionUseCaseDeps) {
    this.#deps = deps;
  }

  async execute(userId: string): Promise<DeletionCancelResult> {
    const { deletionRequests, audit, now } = this.#deps;
    const cancelled = await deletionRequests.cancel(userId, now());
    if (cancelled) {
      audit.record({
        type: 'ACCOUNT_DELETION_CANCELLED',
        outcome: 'succeeded',
        anonymousUserId: toAnonymousUserId(userId),
      });
    }
    return { cancelled };
  }
}
