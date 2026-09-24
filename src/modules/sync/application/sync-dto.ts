/**
 * 同步的对外 DTO 与请求校验（SYNC-001 / SYNC-003 / SYNC-004，《接口文档》§12）。
 *
 * DTO 与校验放同一个文件——两者描述的是同一个边界（HTTP 出入参），拆开会让人在改
 * 字段时只改一半（`task-dto.ts` 的同一条理由）。
 */
import { z } from 'zod';

import { CONFLICT_RESOLUTIONS } from '../domain/sync-conflict.ts';
import type { SyncChange } from '../domain/sync-change.ts';
import { SYNC_OPERATION_TYPES } from '../domain/sync-repository.ts';
import type { PushOperationInput } from './push-operations.ts';

/** 增量拉取响应里的单条变更。 */
export interface SyncChangeDto {
  readonly entityType: string;
  readonly entityId: string;
  readonly version: number;
  readonly deleted: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly changeAt: string;
}

/**
 * 变更 → DTO。
 *
 * 唯一要做的转换是时间：领域里是 `Date`（用于比较与排序），对外必须是 UTC ISO 串
 * （§1.2 的口径）。`payload` 直接透传——它已经由仓储按"`Date` 转 ISO、去掉 `userId`"
 * 归一过，这里再加工一次会形成第二处口径。
 */
export function toSyncChangeDto(change: SyncChange): SyncChangeDto {
  return {
    entityType: change.entityType,
    entityId: change.entityId,
    version: change.version,
    deleted: change.deleted,
    payload: change.payload,
    changeAt: change.changeAt.toISOString(),
  };
}

/**
 * `GET /sync/pull` 的查询参数（§12.1.2）。
 *
 * `limit` 上限 100 与执行记录分页同口径；缺省 50——同步是批量场景，比列表端点
 * （20）大一档，但不至于让一次响应大到客户端解析不动。
 */
export const pullChangesQuerySchema = z
  .object({
    cursor: z.string().min(1).max(128).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const uuidField = z.uuid();

/**
 * `POST /sync/push` 的请求体（§12）。
 *
 * `entityType` 刻意是**自由字符串**而不是枚举：一条批里混着合法与非法类型时，
 * 非法的那条应逐条判成 `rejected`（§12.1.1），而不是让整个批次 400。
 * 类型是否受支持由用例在注册表里查。
 */
export const pushOperationsSchema = z
  .object({
    operations: z
      .array(
        z
          .object({
            operationId: uuidField,
            entityType: z.string().min(1).max(32),
            entityId: uuidField,
            operationType: z.enum(SYNC_OPERATION_TYPES),
            baseVersion: z.number().int().positive().nullish(),
            payload: z.record(z.string(), z.unknown()).default({}),
          })
          .strict(),
      )
      .min(1, '至少提交一条操作')
      .max(100, '一次最多提交 100 条操作'),
  })
  .strict();

/** `POST /sync/conflicts/{conflictId}/resolve` 的请求体（§12、§12.1.3）。 */
export const resolveConflictSchema = z
  .object({
    resolution: z.enum(CONFLICT_RESOLUTIONS),
  })
  .strict();

/** 校验后的 push 单项 → 应用层输入（把 `undefined` 的版本归一成"不校验"的 `null`）。 */
export function toPushOperationInput(operation: {
  readonly operationId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly operationType: (typeof SYNC_OPERATION_TYPES)[number];
  readonly baseVersion?: number | null | undefined;
  readonly payload: Record<string, unknown>;
}): PushOperationInput {
  return {
    operationId: operation.operationId,
    entityType: operation.entityType,
    entityId: operation.entityId,
    operationType: operation.operationType,
    baseVersion: operation.baseVersion ?? null,
    payload: operation.payload,
  };
}
