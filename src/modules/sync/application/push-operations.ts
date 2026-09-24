/**
 * push 的用例（SYNC-003，《接口文档》§12.1.1）。
 *
 * ## 逐条而不是整批
 *
 * 契约把"逐条"写得很明确：HTTP 整体 200，每条操作各自返回
 * `applied | already_applied | conflict | rejected`，一条失败不回滚整批。
 * 因此这里**不用** `withIdempotency`（它的语义是"同 key 已完成 → 整请求 409"），
 * 而是直接编排幂等端口的三个原语，让每条操作自成一体。
 *
 * ## 幂等键与指纹
 *
 * 键 = `"sync:" + operationId`（`sync:` 是保留前缀，普通写请求不得使用），
 * 指纹 = `sha256(entityType | entityId | operationType | payload)`。同键不同指纹
 * 说明同一个 `operationId` 被用在了两条不同的操作上——这是客户端错误，
 * 该条判 `rejected`。
 *
 * ## 顺序执行
 *
 * 批内串行：每条要点一次幂等占位（写 `idempotency_keys`），并行化只会让同一批
 * 操作在连接池里互相排队，收益为零，却让"批内前后顺序"变得不可预期。
 */
import { createHash } from 'node:crypto';

import { ValidationError } from '@/shared/errors/app-error.ts';

import type { SyncIdempotencyClaim, SyncIdempotencyPort } from '../domain/idempotency-port.ts';
import { isSyncEntityType, type SyncEntityType } from '../domain/sync-change.ts';
import type { SyncApplyPort, SyncOperationType } from '../domain/sync-repository.ts';
import type { ConflictService } from './conflict-service.ts';

/** 同步 push 的幂等键保留前缀（§12.1.1）。 */
export const SYNC_IDEMPOTENCY_KEY_PREFIX = 'sync:';

export interface PushOperationInput {
  readonly operationId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly operationType: SyncOperationType;
  readonly baseVersion: number | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** 单条操作的结果。四种状态与契约表格逐行对应。 */
export type PushItemResult =
  | {
      readonly operationId: string;
      readonly status: 'applied';
      readonly entityType: string;
      readonly entityId: string;
      readonly version: number;
    }
  | {
      readonly operationId: string;
      readonly status: 'already_applied';
      readonly entityType: string;
      readonly entityId: string;
      readonly version: number;
    }
  | {
      readonly operationId: string;
      readonly status: 'conflict';
      readonly entityType: string;
      readonly entityId: string;
      readonly conflictId: string;
      readonly serverVersion: number;
      readonly serverPayload: Readonly<Record<string, unknown>>;
    }
  | {
      readonly operationId: string;
      readonly status: 'rejected';
      readonly entityType: string;
      readonly entityId: string;
      readonly reason: string;
    };

export interface PushOperationsDependencies {
  readonly apply: SyncApplyPort;
  readonly idempotency: SyncIdempotencyPort;
  readonly conflicts: ConflictService;
}

/** 成功写入后落进 `response_snapshot` 的内容，`already_applied` 时原样回放。 */
interface AppliedSnapshot {
  readonly entityType: string;
  readonly entityId: string;
  readonly version: number;
}

/** 快照是**服务端自己写的**，形状由本文件决定；读到别的形状说明数据被外力改过。 */
function readSnapshot(value: unknown): AppliedSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const entityType = record['entityType'];
  const entityId = record['entityId'];
  const version = record['version'];
  if (
    typeof entityType !== 'string' ||
    typeof entityId !== 'string' ||
    typeof version !== 'number'
  ) {
    return null;
  }
  return { entityType, entityId, version };
}

/** 请求指纹：`sha256(entityType | entityId | operationType | payload)`（§12.1.1）。 */
function requestHashOf(operation: PushOperationInput): string {
  return createHash('sha256')
    .update(
      [
        operation.entityType,
        operation.entityId,
        operation.operationType,
        JSON.stringify(operation.payload ?? null),
      ].join('|'),
    )
    .digest('hex');
}

export class PushOperationsUseCase {
  readonly #apply: SyncApplyPort;
  readonly #idempotency: SyncIdempotencyPort;
  readonly #conflicts: ConflictService;

  constructor(dependencies: PushOperationsDependencies) {
    this.#apply = dependencies.apply;
    this.#idempotency = dependencies.idempotency;
    this.#conflicts = dependencies.conflicts;
  }

  async execute(
    userId: string,
    operations: readonly PushOperationInput[],
  ): Promise<readonly PushItemResult[]> {
    const results: PushItemResult[] = [];
    for (const operation of operations) {
      results.push(await this.#pushOne(userId, operation));
    }
    return results;
  }

  async #pushOne(userId: string, operation: PushOperationInput): Promise<PushItemResult> {
    const { operationId, entityId } = operation;

    // 类型先在本层判掉：未知类型连幂等行都不该占（占位再释放是多余的两次写），
    // 判完之后 `entityType` 收窄成 `SyncEntityType`，后续构造冲突记录才拿得到类型保证。
    if (!isSyncEntityType(operation.entityType)) {
      return {
        operationId,
        status: 'rejected',
        entityType: operation.entityType,
        entityId,
        reason: `不支持的实体类型：${operation.entityType}`,
      };
    }
    const entityType: SyncEntityType = operation.entityType;

    const key = `${SYNC_IDEMPOTENCY_KEY_PREFIX}${operationId}`;
    let claim: SyncIdempotencyClaim;
    try {
      claim = await this.#idempotency.claim(userId, key, requestHashOf(operation));
    } catch (error) {
      if (error instanceof ValidationError) {
        // 同 `operationId` 不同指纹：同一个键被用在了另一条操作上。
        return { operationId, status: 'rejected', entityType, entityId, reason: error.message };
      }
      throw error;
    }

    if (claim.outcome === 'replay') {
      const snapshot = readSnapshot(claim.snapshot);
      if (snapshot === null) {
        // 占位行还在但快照读不懂 —— 与其回一个错版本号，不如让客户端重试。
        return {
          operationId,
          status: 'rejected',
          entityType,
          entityId,
          reason: '该操作的幂等快照无法解析，请重试',
        };
      }
      return {
        operationId,
        status: 'already_applied',
        entityType: snapshot.entityType,
        entityId: snapshot.entityId,
        version: snapshot.version,
      };
    }
    if (claim.outcome === 'in-progress') {
      // 同一条操作正在被另一个请求处理：本条不重复执行（重复写才是真正的问题）。
      return {
        operationId,
        status: 'rejected',
        entityType,
        entityId,
        reason: '相同操作正在处理中，请稍后重试',
      };
    }

    const outcome = await this.#apply.apply(userId, {
      entityType,
      entityId,
      operationType: operation.operationType,
      baseVersion: operation.baseVersion,
      payload: operation.payload,
    });

    if (outcome.outcome === 'applied') {
      const snapshot: AppliedSnapshot = { entityType, entityId, version: outcome.version };
      await this.#idempotency.complete(userId, key, snapshot);
      return { operationId, status: 'applied', entityType, entityId, version: outcome.version };
    }

    if (outcome.outcome === 'conflict') {
      const conflict = await this.#conflicts.record(userId, {
        entityType,
        entityId,
        localVersion: operation.baseVersion,
        serverVersion: outcome.serverVersion,
        localPayload: operation.payload,
        serverPayload: outcome.serverPayload,
      });
      // 关键（PD-20260923-004 裁定 5）：`conflict` **不** `complete`，而是释放占位。
      // 释放后同一 `operationId` 重发会重新走一遍 CAS，再次判成 conflict 并命中
      // 同一条待处理记录 —— `conflictId` 因此稳定，用户看到的冲突不会换号。
      await this.#idempotency.release(userId, key);
      return {
        operationId,
        status: 'conflict',
        entityType,
        entityId,
        conflictId: conflict.id,
        serverVersion: outcome.serverVersion,
        serverPayload: outcome.serverPayload,
      };
    }

    // `rejected` 同样释放占位：什么都没有改变，客户端修正后应当能用同一个
    // `operationId` 重试，而不是被一条 processing 行永久挡成 rejected。
    await this.#idempotency.release(userId, key);
    return {
      operationId,
      status: 'rejected',
      entityType,
      entityId,
      reason: outcome.reason,
    };
  }
}
