/**
 * 回收区用例（OPS-002，《接口文档》§13 回收区四端点；FR-093 选型「回收区恢复」）。
 *
 * 限流口径：清空＝10 次/小时/用户（契约汇总表）；单条恢复/单删＝30 次/小时/用户
 * （实现级定值，契约只写「更严」——见 `limits.ts` 与 RD-015 披露）。
 * 列表端点不限流（读操作，与既有列表端点同口径）。
 */
import { NotFoundError } from '@/shared/errors/app-error.ts';
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';

import type {
  RateLimiter,
  RecycleEntityType,
  RecycleItem,
  RecycleRepository,
} from '../domain/data-ports.ts';
import { HOUR_MS, RATE_LIMITS, recycleItemOpPerHour } from '../domain/limits.ts';
import { enforceLimit } from './rate-guard.ts';

export interface RecycleUseCaseDeps {
  readonly recycle: RecycleRepository;
  readonly limiter: RateLimiter;
  readonly audit: AuditLogger;
  readonly now: () => Date;
}

/** 列表按删除时间倒序（契约排序口径；上限由路由按 `limit` 截取）。 */
export class ListRecycleUseCase {
  readonly #deps: RecycleUseCaseDeps;

  constructor(deps: RecycleUseCaseDeps) {
    this.#deps = deps;
  }

  async execute(userId: string): Promise<readonly RecycleItem[]> {
    const items = await this.#deps.recycle.list(userId);
    return [...items].sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
  }
}

/** 恢复单条（清 `deleted_at`、`version+1`，契约）。 */
export class RestoreRecycleItemUseCase {
  readonly #deps: RecycleUseCaseDeps;

  constructor(deps: RecycleUseCaseDeps) {
    this.#deps = deps;
  }

  async execute(userId: string, entityType: RecycleEntityType, itemId: string): Promise<void> {
    const { recycle, limiter, audit, now } = this.#deps;
    enforceLimit(limiter, 'recycle-item', userId, recycleItemOpPerHour, HOUR_MS);

    const restored = await recycle.restore(userId, entityType, itemId, now());
    if (!restored) {
      // 不存在 / 非本人 / 已恢复——归一 404，不泄露存在性（契约回收区节）。
      throw new NotFoundError('回收区条目不存在');
    }
    audit.record({
      type: 'DATA_RESTORED',
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
    });
  }
}

/** 单条永久删除（物理行 + 事务；客户端须先过 ConfirmDialog——UI 纪律）。 */
export class RemoveRecycleItemUseCase {
  readonly #deps: RecycleUseCaseDeps;

  constructor(deps: RecycleUseCaseDeps) {
    this.#deps = deps;
  }

  async execute(userId: string, entityType: RecycleEntityType, itemId: string): Promise<void> {
    const { recycle, limiter, audit } = this.#deps;
    enforceLimit(limiter, 'recycle-item', userId, recycleItemOpPerHour, HOUR_MS);

    const removed = await recycle.remove(userId, entityType, itemId);
    if (!removed) {
      throw new NotFoundError('回收区条目不存在');
    }
    audit.record({
      type: 'DATA_DELETED',
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
    });
  }
}

/** 清空回收区（全部类型；限流 10 次/小时/用户——契约汇总表）。 */
export class ClearRecycleUseCase {
  readonly #deps: RecycleUseCaseDeps;

  constructor(deps: RecycleUseCaseDeps) {
    this.#deps = deps;
  }

  async execute(userId: string): Promise<number> {
    const { recycle, limiter, audit } = this.#deps;
    enforceLimit(limiter, 'recycle-clear', userId, RATE_LIMITS.recycleClearPerHour, HOUR_MS);

    const cleared = await recycle.clear(userId);
    audit.record({
      type: 'DATA_DELETED',
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
    });
    return cleared;
  }
}
