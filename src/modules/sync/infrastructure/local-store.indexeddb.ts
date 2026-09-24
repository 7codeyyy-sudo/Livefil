/**
 * IndexedDB 薄封装（SYNC-002，《详细设计说明书》§5.4.1）。
 *
 * ## 为什么是原生 IndexedDB + 项目内薄封装
 *
 * §5.4.1 的选型结论（SYNC-000 spike S1 的实测依据）：不引入 idb / Dexie。
 * 本批只用三个 store、一个迁移表与一个事务助手，而任何第三方封装都会把
 * 「事务边界」这条最关键的语义藏到自己的 API 后面——恰恰是它最容易出错。
 *
 * ## 事务助手解决的正是那个经典陷阱
 *
 * 原生 IndexedDB 的事务会在**微任务检查点**上自动提交：只要事务里没有待处理
 * 请求，它就结束了。于是在 `readwrite` 事务回调里 `await` 一个**非 IDB 的**
 * Promise（`fetch`、定时器）之后再去 `objectStore()`，事务已经提交，写操作要么
 * 抛 `InvalidStateError`，要么（更糟）静默地什么都没写。
 *
 * 两件事一起做才成立：
 * 1. 所有读写都经 `runInTransaction` 打开事务，且**只在事务里 await IDB 请求**
 *    （它们由 success 事件驱动，事件派发期间事务仍是 active）；
 * 2. 每次发起请求前 `assertTransactionActive` 复核 `readyState`——一旦有人在
 *    事务里 await 了别的东西，报出来的是一句说得清的错误，而不是一个
 *    「数据没写进去」的静默 bug。
 *
 * ## 本文件是唯一的 IndexedDB 访问点
 *
 * `eslint.config.mjs` 的 `INDEXED_DB_ACCESS_RULES` 禁止 `app` 下的源码、各模块
 * 的 `presentation` 目录与 `src/shared/ui` 触碰 `indexedDB` / `IDBDatabase`
 * 等全局名。目的不是"禁止用 IndexedDB"，而是让"谁在直接操作浏览器存储"这件事
 * 在仓库里只有一个答案——界面层想读本地数据，必须经过 `LocalStore` 端口。
 */
import {
  PENDING_OPERATION_STORE_NAME,
  SNAPSHOT_STORE_NAME,
  SYNC_CURSOR_STORE_NAME,
  childEntityTypesOf,
  readParentEntityId,
  type ApplyRemoteChangeOutcome,
  type EntitySnapshotRecord,
  type LocalStore,
  type PendingOperationPatch,
  type PendingOperationRecord,
  type PendingOperationStatus,
  type RemoteChangeInput,
  type SyncCursorRecord,
} from '../domain/local-store.ts';

/** 数据库名。一个应用一个库：本地模式只有一个数据空间（UI 规范 §4.9.3）。 */
const DATABASE_NAME = 'livefil-sync';

/**
 * 数据库版本。
 *
 * 整数版本 + 集中式迁移表是 IndexedDB 的标准演进方式：它只会跑「比当前库版本
 * 更高」的那些迁移，因此新增一个 store 只需往 `MIGRATIONS` 里加一项并把
 * `DATABASE_VERSION` +1，不必写任何「如果表不存在就建」的分支判断。
 */
const DATABASE_VERSION = 2;

/** `pending_operations` 上按实体查找的索引名（v2 新增）。 */
const BY_ENTITY_INDEX = 'by_entity';

/**
 * 迁移表：版本号 → 迁移函数。
 *
 * 每一项只做**增量**（从 `version - 1` 到 `version`），不重复创建已存在的对象——
 * 把它写成"幂等的建表脚本"会让 v1 与 v2 的功能差异彻底不可见，而版本号存在的
 * 意义正是让这种差异可见。
 *
 * v1 建三个 store；v2 给 `pending_operations` 补一个 `(entityType, entityId)`
 * 复合索引（冲突记录与级联清理都要按实体定位操作）。
 */
const MIGRATIONS: Readonly<Record<number, (db: IDBDatabase, tx: IDBTransaction) => void>> = {
  1: (db) => {
    const snapshots = db.createObjectStore(SNAPSHOT_STORE_NAME, {
      keyPath: ['entityType', 'entityId'],
    });
    snapshots.createIndex('by_entityType', 'entityType', { unique: false });

    const operations = db.createObjectStore(PENDING_OPERATION_STORE_NAME, {
      keyPath: 'operationId',
    });
    operations.createIndex('by_status', 'status', { unique: false });

    db.createObjectStore(SYNC_CURSOR_STORE_NAME, { keyPath: 'id' });
  },
  2: (_db, tx) => {
    tx.objectStore(PENDING_OPERATION_STORE_NAME).createIndex(
      BY_ENTITY_INDEX,
      ['entityType', 'entityId'],
      { unique: false },
    );
  },
};

/**
 * `readyState` 的窄化视图。
 *
 * `lib.dom` 目前没有声明 `IDBTransaction.readyState`（规范里它是必备成员），
 * 因此这里补一个**可选**视图。写成可选而不是断言它一定存在：在不提供该属性的
 * 实现上应当退回"不检查"，而不是把每一次正常写入都判成事务已结束。
 */
type TransactionReadyStateView = IDBTransaction & { readonly readyState?: string | undefined };

/**
 * 复核事务仍可写。
 *
 * @throws {Error} 事务已提交/已中止时抛出——原因几乎总是「在事务里 await 了
 *   非 IDB 的 Promise」，错误文案直接把这条线索写出来。
 */
function assertTransactionActive(tx: IDBTransaction): void {
  const readyState = (tx as TransactionReadyStateView).readyState;

  if (readyState !== undefined && readyState !== 'active') {
    throw new Error(
      `IndexedDB 事务已经结束（readyState=${readyState}）：` +
        '在事务回调里 await 了非 IDB 的 Promise，原生 IDB 会在微任务检查点上自动提交。' +
        '请把网络调用等异步工作挪到事务之外，本事务内只 await IDB 请求。',
    );
  }
}

/** 取 store 并复核事务仍可写。 */
function storeOf(tx: IDBTransaction, name: string): IDBObjectStore {
  assertTransactionActive(tx);
  return tx.objectStore(name);
}

/** 把一个 IDB 请求包成 Promise（由 success / error 事件驱动）。 */
function wrapRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = (): void => {
      resolve(request.result);
    };
    request.onerror = (): void => {
      reject(request.error ?? new Error('IndexedDB 请求失败'));
    };
  });
}

/** 事务整体完成的 Promise（complete / error / abort 三选一）。 */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = (): void => {
      resolve();
    };
    tx.onerror = (): void => {
      reject(tx.error ?? new Error('IndexedDB 事务失败'));
    };
    tx.onabort = (): void => {
      reject(tx.error ?? new Error('IndexedDB 事务被中止'));
    };
  });
}

/**
 * 在单个事务里执行一次读写。
 *
 * `fn` 只应 await 本事务内的 IDB 请求。抛错时事务被中止，改动整体回滚——
 * 「读到的旧值 + 写了一半的新值」这种中间状态不会留在库里。
 *
 * @param db 已打开的连接。
 * @param names 事务覆盖的 store（**必须**在创建事务时列全：IndexedDB 不允许
 *   在事务进行中扩大作用域，漏写一个 store 的后果是 `objectStore()` 直接抛错）。
 * @param mode `readonly` 或 `readwrite`。
 * @param fn 事务体。
 */
async function runInTransaction<T>(
  db: IDBDatabase,
  names: readonly string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const tx = db.transaction(names, mode);
  const done = transactionDone(tx);

  let result: T;
  try {
    result = await fn(tx);
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // 事务可能已经自行中止（请求失败会连带中止它）。这里只关心把原始错误抛出去。
    }
    throw error;
  }

  await done;
  return result;
}

/** 读一条记录；不存在返回 `null`（`get` 的 undefined 归一成 null）。 */
async function readRecord<T>(
  tx: IDBTransaction,
  storeName: string,
  key: IDBValidKey,
): Promise<T | null> {
  const value = await wrapRequest<unknown>(storeOf(tx, storeName).get(key));
  return value === undefined ? null : (value as T);
}

/** 读一个 store 的全部记录。 */
async function readAll<T>(tx: IDBTransaction, storeName: string): Promise<readonly T[]> {
  // `getAll()` 的返回类型是 `IDBRequest<any[]>`；显式写 `<unknown>` 会因为
  // `IDBRequest` 的 `this` 类型逆变而无法赋值，这里让 T 随请求推导。
  const value = await wrapRequest(storeOf(tx, storeName).getAll());
  return Array.isArray(value) ? (value as T[]) : [];
}

/** 打开连接；`onupgradeneeded` 里按集中式迁移表逐版本推进。 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = (event): void => {
      const tx = request.transaction;
      if (tx === null) {
        reject(new Error('IndexedDB 升级时没有可用事务'));
        return;
      }
      try {
        for (let version = event.oldVersion + 1; version <= DATABASE_VERSION; version += 1) {
          MIGRATIONS[version]?.(request.result, tx);
        }
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };

    request.onsuccess = (): void => {
      const db = request.result;
      // 另一个标签页发起升级时主动让路：不关闭连接会让它的 upgrade 永远阻塞。
      db.onversionchange = (): void => {
        db.close();
      };
      resolve(db);
    };

    request.onerror = (): void => {
      reject(request.error ?? new Error('IndexedDB 打开失败'));
    };
  });
}

/**
 * 级联清理一个实体及其子实体的本地快照。
 *
 * 子实体是**严格从属**的：`routine` 的墓碑意味着服务端已经不存在这条例程，
 * 它的 `routine_step` 便没有了归属（DB §4.18.1 记的正是这个缺口——服务端
 * 不会硬删子行，客户端必须自己收拾）。
 *
 * @returns 被清掉的子实体 id（调用方据此再清理子实体的排队操作）。
 */
async function purgeSnapshots(
  tx: IDBTransaction,
  entityType: string,
  entityId: string,
): Promise<readonly string[]> {
  const childTypes = childEntityTypesOf(entityType);
  const orphanChildIds: string[] = [];

  if (childTypes.length > 0) {
    const rows = await readAll<EntitySnapshotRecord>(tx, SNAPSHOT_STORE_NAME);
    for (const row of rows) {
      if (!childTypes.includes(row.entityType)) {
        continue;
      }
      if (readParentEntityId(row.entityType, row.payload) !== entityId) {
        continue;
      }
      orphanChildIds.push(row.entityId);
      await wrapRequest(storeOf(tx, SNAPSHOT_STORE_NAME).delete([row.entityType, row.entityId]));
    }
  }

  await wrapRequest(storeOf(tx, SNAPSHOT_STORE_NAME).delete([entityType, entityId]));

  return orphanChildIds;
}

/**
 * 删掉某个实体类型的指定若干实体的排队操作（级联产生的孤儿操作）。
 *
 * **只清子实体的操作**：它们的父级已经不存在，重试永远不会成功，留着只会把
 * 「同步被拒绝」计数永久占住。父实体自己的排队操作不动——那是用户显式表达过的
 * 意图，交给 push 给出结论（applied / rejected），而不是被同步层悄悄丢弃
 * （NFR-REL-004 对"系统自动路径"的限制）。
 */
async function removeOperationsForEntities(
  tx: IDBTransaction,
  entityType: string,
  entityIds: readonly string[],
): Promise<void> {
  if (entityIds.length === 0) {
    return;
  }
  const wanted = new Set(entityIds);
  const operations = await readAll<PendingOperationRecord>(tx, PENDING_OPERATION_STORE_NAME);

  for (const operation of operations) {
    if (operation.entityType !== entityType || !wanted.has(operation.entityId)) {
      continue;
    }
    await wrapRequest(storeOf(tx, PENDING_OPERATION_STORE_NAME).delete(operation.operationId));
  }
}

/**
 * 创建基于 IndexedDB 的本地存储。
 *
 * 连接懒打开并缓存：SSR 阶段本模块会被求值（客户端组件同样参与服务端渲染），
 * 但**只有真正调用方法时**才碰 `indexedDB`，因此不会在服务端炸掉。
 */
export function createIndexedDbLocalStore(): LocalStore {
  let connection: Promise<IDBDatabase> | null = null;

  function db(): Promise<IDBDatabase> {
    connection ??= openDatabase();
    return connection;
  }

  return {
    async readSnapshot(entityType, entityId): Promise<EntitySnapshotRecord | null> {
      const database = await db();
      return await runInTransaction(database, [SNAPSHOT_STORE_NAME], 'readonly', (tx) =>
        readRecord<EntitySnapshotRecord>(tx, SNAPSHOT_STORE_NAME, [entityType, entityId]),
      );
    },

    async putSnapshot(record): Promise<void> {
      const database = await db();
      await runInTransaction(database, [SNAPSHOT_STORE_NAME], 'readwrite', async (tx) => {
        await wrapRequest(storeOf(tx, SNAPSHOT_STORE_NAME).put(record));
      });
    },

    async listSnapshots(entityType): Promise<readonly EntitySnapshotRecord[]> {
      const database = await db();
      return await runInTransaction(database, [SNAPSHOT_STORE_NAME], 'readonly', async (tx) => {
        const index = storeOf(tx, SNAPSHOT_STORE_NAME).index('by_entityType');
        // 同 `readAll`：`getAll()` 的请求类型是 `any[]`，让 T 随请求推导。
        const value = await wrapRequest(index.getAll(entityType));
        return Array.isArray(value) ? (value as EntitySnapshotRecord[]) : [];
      });
    },

    async markSnapshotSynced({ entityType, entityId, version, changeAt }): Promise<void> {
      const database = await db();
      await runInTransaction(database, [SNAPSHOT_STORE_NAME], 'readwrite', async (tx) => {
        const current = await readRecord<EntitySnapshotRecord>(tx, SNAPSHOT_STORE_NAME, [
          entityType,
          entityId,
        ]);
        // 不存在或已确认：没有需要确认的本地改动，静默忽略（见端口说明）。
        if (current === null || current.syncState !== 'pending') {
          return;
        }
        await wrapRequest(
          storeOf(tx, SNAPSHOT_STORE_NAME).put({
            ...current,
            version,
            changeAt,
            syncState: 'synced',
          }),
        );
      });
    },

    async applyRemoteChange(change: RemoteChangeInput): Promise<ApplyRemoteChangeOutcome> {
      const database = await db();
      return await runInTransaction(
        database,
        [SNAPSHOT_STORE_NAME, PENDING_OPERATION_STORE_NAME],
        'readwrite',
        async (tx) => {
          if (change.deleted) {
            const orphans = await purgeSnapshots(tx, change.entityType, change.entityId);
            for (const childType of childEntityTypesOf(change.entityType)) {
              await removeOperationsForEntities(tx, childType, orphans);
            }
            return 'purged';
          }

          const existing = await readRecord<EntitySnapshotRecord>(tx, SNAPSHOT_STORE_NAME, [
            change.entityType,
            change.entityId,
          ]);

          if (existing !== null) {
            // 本地有未同步的改动：**不**让远端数据盖掉它（NFR-REL-004 禁止系统
            // 自动路径覆盖本地数据）。它会在 push 时以 CAS 冲突的形式浮出来，
            // 由用户在冲突弹层里二选。
            if (existing.syncState !== 'synced') {
              return 'ignored';
            }
            // 幂等：同一版本（或更旧的）重复到达什么都不做。
            if (existing.version >= change.version) {
              return 'ignored';
            }
          }

          const next: EntitySnapshotRecord = {
            entityType: change.entityType,
            entityId: change.entityId,
            version: change.version,
            deleted: false,
            payload: change.payload,
            changeAt: change.changeAt,
            syncState: 'synced',
          };
          await wrapRequest(storeOf(tx, SNAPSHOT_STORE_NAME).put(next));
          return 'applied';
        },
      );
    },

    async enqueueOperation(record): Promise<void> {
      const database = await db();
      await runInTransaction(database, [PENDING_OPERATION_STORE_NAME], 'readwrite', async (tx) => {
        await wrapRequest(storeOf(tx, PENDING_OPERATION_STORE_NAME).put(record));
      });
    },

    async listOperations(
      status?: PendingOperationStatus,
    ): Promise<readonly PendingOperationRecord[]> {
      const database = await db();
      return await runInTransaction(
        database,
        [PENDING_OPERATION_STORE_NAME],
        'readonly',
        async (tx) => {
          if (status === undefined) {
            return readAll<PendingOperationRecord>(tx, PENDING_OPERATION_STORE_NAME);
          }
          const index = storeOf(tx, PENDING_OPERATION_STORE_NAME).index('by_status');
          // 同 `readAll`：`getAll()` 的请求类型是 `any[]`，让 T 随请求推导。
          const value = await wrapRequest(index.getAll(status));
          return Array.isArray(value) ? (value as PendingOperationRecord[]) : [];
        },
      );
    },

    async updateOperation(operationId: string, patch: PendingOperationPatch): Promise<void> {
      const database = await db();
      await runInTransaction(database, [PENDING_OPERATION_STORE_NAME], 'readwrite', async (tx) => {
        const current = await readRecord<PendingOperationRecord>(
          tx,
          PENDING_OPERATION_STORE_NAME,
          operationId,
        );
        if (current === null) {
          // 已被另一个轮次处理掉（推送成功移除 / 冲突已在别处解决）：静默忽略。
          return;
        }

        const next: PendingOperationRecord = {
          ...current,
          status: patch.status,
          rejectReason:
            patch.rejectReason === undefined ? current.rejectReason : patch.rejectReason,
          conflictId: patch.conflictId === undefined ? current.conflictId : patch.conflictId,
          conflictServerVersion:
            patch.conflictServerVersion === undefined
              ? current.conflictServerVersion
              : patch.conflictServerVersion,
          conflictServerPayload:
            patch.conflictServerPayload === undefined
              ? current.conflictServerPayload
              : patch.conflictServerPayload,
        };
        await wrapRequest(storeOf(tx, PENDING_OPERATION_STORE_NAME).put(next));
      });
    },

    async removeOperation(operationId: string): Promise<void> {
      const database = await db();
      await runInTransaction(database, [PENDING_OPERATION_STORE_NAME], 'readwrite', async (tx) => {
        await wrapRequest(storeOf(tx, PENDING_OPERATION_STORE_NAME).delete(operationId));
      });
    },

    async readCursor(id: string): Promise<string | null> {
      const database = await db();
      return await runInTransaction(database, [SYNC_CURSOR_STORE_NAME], 'readonly', async (tx) => {
        const record = await readRecord<SyncCursorRecord>(tx, SYNC_CURSOR_STORE_NAME, id);
        return record === null ? null : record.value;
      });
    },

    async writeCursor(id: string, value: string): Promise<void> {
      const database = await db();
      await runInTransaction(database, [SYNC_CURSOR_STORE_NAME], 'readwrite', async (tx) => {
        const record: SyncCursorRecord = { id, value };
        await wrapRequest(storeOf(tx, SYNC_CURSOR_STORE_NAME).put(record));
      });
    },
  };
}
