/**
 * 内存版本地存储（SYNC-002）。
 *
 * ## 为什么需要它
 *
 * 两个场景：
 * 1. **SSR / jsdom**——服务端渲染时没有 `indexedDB`，而客户端组件同样要参与
 *    服务端渲染；jsdom 也不提供它。此时必须有一个能跑的实现，否则整棵组件树
 *    在首屏就崩。（`client-composition-root.ts` 按 `typeof indexedDB` 选择。）
 * 2. **单测**——纯逻辑测试不该依赖浏览器存储的异步事件模型。
 *
 * ## 它与 IndexedDB 版的差别只有一个：寿命
 *
 * 语义（幂等 upsert、墓碑清理、父级级联、状态流转）必须与
 * `local-store.indexeddb.ts` **逐条一致**，否则"内存里测过、浏览器里坏掉"。
 * 差别只在数据不落地：进程（或这个实例）结束即失忆。
 *
 * 这里刻意**不**模拟事务的读写交错：内存实现天然是一次事件循环内的连续操作，
 * 没有"事务被自动提交"这件事。把那条纪律抄进来只会造出一个假的事务模型。
 */
import {
  childEntityTypesOf,
  readParentEntityId,
  type ApplyRemoteChangeOutcome,
  type EntitySnapshotRecord,
  type LocalStore,
  type PendingOperationPatch,
  type PendingOperationRecord,
  type PendingOperationStatus,
  type RemoteChangeInput,
} from '../domain/local-store.ts';

/** 复合键：与 IndexedDB 版 `[entityType, entityId]` 的 keyPath 同形。 */
function snapshotKey(entityType: string, entityId: string): string {
  return `${entityType}\u0000${entityId}`;
}

/**
 * 创建内存版本地存储。
 *
 * 每次调用返回一个**独立**的实例（各有自己的数据）：单测之间互不污染，
 * SSR 的每次渲染也不会共享一份全局可变状态。
 */
export function createMemoryLocalStore(): LocalStore {
  const snapshots = new Map<string, EntitySnapshotRecord>();
  const operations = new Map<string, PendingOperationRecord>();
  const cursors = new Map<string, string>();

  return {
    readSnapshot(entityType, entityId): Promise<EntitySnapshotRecord | null> {
      return Promise.resolve(snapshots.get(snapshotKey(entityType, entityId)) ?? null);
    },

    putSnapshot(record): Promise<void> {
      snapshots.set(snapshotKey(record.entityType, record.entityId), record);
      return Promise.resolve();
    },

    applyRemoteChange(change: RemoteChangeInput): Promise<ApplyRemoteChangeOutcome> {
      if (change.deleted) {
        for (const childType of childEntityTypesOf(change.entityType)) {
          for (const [key, row] of snapshots) {
            if (row.entityType !== childType) {
              continue;
            }
            if (readParentEntityId(row.entityType, row.payload) !== change.entityId) {
              continue;
            }
            snapshots.delete(key);
            // 子实体的排队操作同样是孤儿：见 indexeddb 版同处的说明。
            for (const [operationId, operation] of operations) {
              if (operation.entityType === childType && operation.entityId === row.entityId) {
                operations.delete(operationId);
              }
            }
          }
        }
        snapshots.delete(snapshotKey(change.entityType, change.entityId));
        return Promise.resolve('purged');
      }

      const existing = snapshots.get(snapshotKey(change.entityType, change.entityId)) ?? null;
      if (existing !== null) {
        if (existing.syncState !== 'synced') {
          return Promise.resolve('ignored');
        }
        if (existing.version >= change.version) {
          return Promise.resolve('ignored');
        }
      }

      snapshots.set(snapshotKey(change.entityType, change.entityId), {
        entityType: change.entityType,
        entityId: change.entityId,
        version: change.version,
        deleted: false,
        payload: change.payload,
        changeAt: change.changeAt,
        syncState: 'synced',
      });
      return Promise.resolve('applied');
    },

    enqueueOperation(record): Promise<void> {
      operations.set(record.operationId, record);
      return Promise.resolve();
    },

    listOperations(status?: PendingOperationStatus): Promise<readonly PendingOperationRecord[]> {
      const all = [...operations.values()];
      return Promise.resolve(
        status === undefined ? all : all.filter((operation) => operation.status === status),
      );
    },

    updateOperation(operationId: string, patch: PendingOperationPatch): Promise<void> {
      const current = operations.get(operationId);
      if (current === undefined) {
        return Promise.resolve();
      }

      operations.set(operationId, {
        ...current,
        status: patch.status,
        rejectReason: patch.rejectReason === undefined ? current.rejectReason : patch.rejectReason,
        conflictId: patch.conflictId === undefined ? current.conflictId : patch.conflictId,
        conflictServerVersion:
          patch.conflictServerVersion === undefined
            ? current.conflictServerVersion
            : patch.conflictServerVersion,
        conflictServerPayload:
          patch.conflictServerPayload === undefined
            ? current.conflictServerPayload
            : patch.conflictServerPayload,
      });
      return Promise.resolve();
    },

    removeOperation(operationId: string): Promise<void> {
      operations.delete(operationId);
      return Promise.resolve();
    },

    readCursor(id: string): Promise<string | null> {
      return Promise.resolve(cursors.get(id) ?? null);
    },

    writeCursor(id: string, value: string): Promise<void> {
      cursors.set(id, value);
      return Promise.resolve();
    },
  };
}
