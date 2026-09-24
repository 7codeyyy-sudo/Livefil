/**
 * 客户端同步引擎（SYNC-002 / SYNC-003 / SYNC-004，《接口文档》§12、《详细设计说明书》§5.4）。
 *
 * ## 它是什么，不是什么
 *
 * 它是一个**编排器**：把「本地队列 → push → 结果回写队列」「pull → 本地快照」
 * 「用户二选 → resolve」这三条流转接起来，并把队列聚合成横幅需要的视图。
 *
 * 不是：不是 React 组件（不引框架），不是 HTTP 客户端（网络经 `SyncTransport`
 * 端口注入），不是存储实现（持久化经 `LocalStore` 端口注入）。三条边界都靠端口
 * 划开，因此它可以脱离浏览器与 Next.js 被理解与推演。
 *
 * ## 为什么需要一个外部存储式的订阅接口
 *
 * 《详细设计说明书》§5.4.1 要求 IndexedDB 的变更经 `useSyncExternalStore` 订阅。
 * 本类就是那个「外部可变数据源」：`subscribe` / `getSnapshot` / `getServerSnapshot`
 * 三个方法直接对上 React 的约定，快照对象在两次真实变化之间**保持同一引用**
 * （否则 `useSyncExternalStore` 会在渲染中抛"快照不稳定"）。
 *
 * ## 与 `useAsyncQuery` 的关系：没有关系
 *
 * §4.9.1 明文：outbox 同步层不走也不改 §4.7 的取数原语。那边是"页面取数、
 * 不自动重试、不缓存"，这边是"后台推送、按在线事件重试、本地有队列"。两条
 * 生命周期完全不同，强行合并会让任一边的纪律都失效。
 */
import {
  LOCAL_SYNC_CURSOR_ID,
  type LocalStore,
  type PendingOperationRecord,
  type PendingOperationStatus,
  type RemoteChangeInput,
} from '../domain/local-store.ts';
import type { SyncOperationType } from '../domain/sync-repository.ts';

/** 单次 push 的操作上限（《接口文档》§12 上限 100）。 */
const DEFAULT_PUSH_BATCH_SIZE = 100;

/** 单次 pull 的页大小（§12.1.2 上限 100；50 与"一次批量"的口径一致）。 */
const DEFAULT_PULL_PAGE_SIZE = 50;

/**
 * 一轮同步最多拉多少页。
 *
 * 上限存在的意义不是性能而是**收敛**：没有它，一个持续写入的服务端会让
 * `sync()` 永不返回，而界面会一直停在"同步中…"。
 */
const MAX_PULL_PAGES = 5;

/** 摘要里最多列几个关键字段（§4.9.2 第 3 条：不超过 3 行）。 */
const MAX_SUMMARY_FIELDS = 3;

/**
 * 关键字段的展示顺序与中文名。
 *
 * 顺序即优先级：实体名与状态最能让用户认出"这是哪一条"，日期次之。
 * 用一张表而不是逐类型分支：9 个实体类型共用同一份口径，表比分支好维护。
 */
const SUMMARY_FIELDS: readonly (readonly [string, string])[] = [
  ['title', '标题'],
  ['name', '名称'],
  ['status', '状态'],
  ['localDate', '日期'],
  ['dueDate', '截止日期'],
  ['startsAtUtc', '开始时间'],
  ['estimatedMinutes', '预估时长'],
  ['minimumVersion', '最低版本'],
];

/** 一条待推送的操作（与 `POST /sync/push` 的单条入参同形）。 */
export interface SyncPushOperation {
  readonly operationId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly operationType: SyncOperationType;
  readonly baseVersion: number | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * push 的逐条结果（§12.1.1 四态）。
 *
 * `applied` 与 `already_applied` 合并成一条分支：对客户端而言两者都是
 * "这条操作已经不需要再推送了"，区别只在服务端是否真的执行过。
 */
export type SyncPushResult =
  | {
      readonly operationId: string;
      readonly status: 'applied' | 'already_applied';
      readonly version: number;
    }
  | {
      readonly operationId: string;
      readonly status: 'conflict';
      readonly conflictId: string;
      readonly serverVersion: number;
      readonly serverPayload: Readonly<Record<string, unknown>>;
    }
  | {
      readonly operationId: string;
      readonly status: 'rejected';
      readonly reason: string;
    };

/** 一条拉回来的变更。`changeAt` 是契约口径的 UTC ISO 串。 */
export interface SyncPulledChange {
  readonly entityType: string;
  readonly entityId: string;
  readonly version: number;
  readonly deleted: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly changeAt: string;
}

/** 一页变更。 */
export interface SyncPullPage {
  readonly changes: readonly SyncPulledChange[];
  /** 本页最后一条的游标；本页为空时为 `null`。 */
  readonly nextCursor: string | null;
}

/** 冲突解决方式（§12.1.3 的 P0 取值）。 */
export type ConflictResolutionChoice = 'keep_server' | 'keep_local';

/**
 * 同步传输端口。
 *
 * 由 `app/(app)/_lib/sync-runtime.ts` 用 `api-client` 实现、经构造函数注入。
 * 端口定义在应用层而不是领域层：它描述的是"怎么把这三条 HTTP 调用发出去"，
 * 与领域规则无关；而领域层若定义它，就得同时定义 HTTP 语义（领域不该知道 HTTP）。
 */
export interface SyncTransport {
  push(operations: readonly SyncPushOperation[]): Promise<readonly SyncPushResult[]>;
  pull(cursor: string | null, limit: number): Promise<SyncPullPage>;
  resolve(conflictId: string, resolution: ConflictResolutionChoice): Promise<void>;
}

/** 一次本地写操作的内容（由 `api-client` 在请求失败时交给引擎）。 */
export interface SyncWriteInput {
  readonly entityType: string;
  readonly entityId: string;
  readonly operationType: SyncOperationType;
  readonly baseVersion: number | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** 「查看详情」列表里的一行。 */
export interface SyncRejectedView {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

/** 冲突弹层需要的一个版本摘要（与共享组件的 `ConflictVersionView` 结构一致）。 */
export interface SyncVersionView {
  readonly changedAtLabel: string | null;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
}

/** 冲突弹层需要的一条冲突。 */
export interface SyncConflictView {
  readonly conflictId: string;
  readonly entityName: string;
  readonly local: SyncVersionView;
  readonly server: SyncVersionView;
}

/** 队列聚合出的视图（横幅六态的原始输入）。 */
export interface SyncQueueSnapshot {
  /** 正在推送（横幅状态 2）。 */
  readonly syncing: boolean;
  /** 待推送的**操作**数（横幅状态 3/4 的计数口径）。 */
  readonly pendingCount: number;
  readonly failedCount: number;
  /** 被拒绝的**条目**列表（横幅状态 5；计数即长度）。 */
  readonly rejected: readonly SyncRejectedView[];
  /** 待处理冲突（横幅状态 6）。 */
  readonly conflicts: readonly SyncConflictView[];
}

/** 空快照：既作初值，也作服务端快照（SSR 一律按"无待同步项"渲染）。 */
const EMPTY_SNAPSHOT: SyncQueueSnapshot = {
  syncing: false,
  pendingCount: 0,
  failedCount: 0,
  rejected: [],
  conflicts: [],
};

export interface SyncClientDependencies {
  readonly store: LocalStore;
  readonly transport: SyncTransport;
  /** 当前时间（毫秒）；注入以便测试固定时钟。 */
  readonly now?: (() => number) | undefined;
  /** 生成 `operationId`；缺省用 `crypto.randomUUID()`（§12.1.1 要求 UUID）。 */
  readonly newId?: (() => string) | undefined;
  readonly pushBatchSize?: number | undefined;
  readonly pullPageSize?: number | undefined;
}

export class SyncClient {
  readonly #store: LocalStore;
  readonly #transport: SyncTransport;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #pushBatchSize: number;
  readonly #pullPageSize: number;

  #snapshot: SyncQueueSnapshot = EMPTY_SNAPSHOT;
  readonly #listeners = new Set<() => void>();

  /** 正在推送。与 `#busy` 分开：前者决定横幅显不显示"同步中"，后者防重入。 */
  #syncing = false;
  #busy = false;

  constructor(dependencies: SyncClientDependencies) {
    this.#store = dependencies.store;
    this.#transport = dependencies.transport;
    this.#now = dependencies.now ?? ((): number => Date.now());
    this.#newId = dependencies.newId ?? ((): string => crypto.randomUUID());
    this.#pushBatchSize = dependencies.pushBatchSize ?? DEFAULT_PUSH_BATCH_SIZE;
    this.#pullPageSize = dependencies.pullPageSize ?? DEFAULT_PULL_PAGE_SIZE;
  }

  /**
   * 订阅快照变化。
   *
   * 写成实例上的箭头属性（而不是原型方法）：`useSyncExternalStore` 每次渲染都会
   * 比对 `subscribe` 的引用，原型方法在解构后会丢失 `this`。
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return (): void => {
      this.#listeners.delete(listener);
    };
  };

  /** 当前快照。两次真实变化之间返回**同一引用**。 */
  readonly getSnapshot = (): SyncQueueSnapshot => this.#snapshot;

  /** 服务端快照：SSR 一律按"无待同步项"处理（客户端存储只存在于浏览器）。 */
  readonly getServerSnapshot = (): SyncQueueSnapshot => EMPTY_SNAPSHOT;

  /**
   * 重新读取队列并刷新快照。
   *
   * 读失败时保留上一次快照而不抛错：本地存储读不出来（隐私模式、配额耗尽、
   * 库被另一标签页升级）是环境问题，而同步状态不是阻塞性故障——把它变成
   * 一个 reject 只会让调用方多一处无处安放的 catch。
   */
  async refresh(): Promise<void> {
    try {
      const operations = await this.#store.listOperations();
      this.#setSnapshot(operations);
    } catch {
      // 见方法说明：保留上一次快照即可。
    }
  }

  /**
   * 入队一条本地写操作。
   *
   * 由 `api-client` 在**写请求没能拿到服务端结论**时调用（网络错误 / 超时 /
   * 响应不是契约 JSON）。此时这条编辑只存在于本地，队列是它唯一的载体。
   */
  async enqueueWrite(input: SyncWriteInput): Promise<void> {
    await this.#store.enqueueOperation({
      operationId: this.#newId(),
      entityType: input.entityType,
      entityId: input.entityId,
      operationType: input.operationType,
      baseVersion: input.baseVersion,
      payload: input.payload,
      createdAt: this.#now(),
      status: 'pending',
      rejectReason: null,
      conflictId: null,
      conflictServerVersion: null,
      conflictServerPayload: null,
    });
    await this.refresh();
  }

  /**
   * 跑一轮同步：先推队列，再拉增量。
   *
   * @param options.manual 是否由用户点击「立即同步」触发。**只有手动**才会重推
   *   被拒绝的操作（§4.9.1：自动重试只发生在网络恢复与页面重新可见两个时机，
   *   而被拒绝是永久性结论——自动重推它等于每次切回标签页都打一次注定失败的请求）。
   * @returns `ok` 为 false 表示这一轮里有传输失败（推送或拉取）；调用方据此决定
   *   要不要发「同步完成」提示（§4.9.1：只有用户手动同步成功才发 Toast）。
   */
  async sync(options: { readonly manual: boolean }): Promise<{ readonly ok: boolean }> {
    if (this.#busy) {
      // 已有一轮在跑：不并发第二轮（两条 push 交错会让同一批操作被推两次，
      // 虽然幂等键能兜住，但状态回写会互相覆盖）。
      return { ok: false };
    }

    this.#busy = true;
    let ok = true;

    try {
      const operations = await this.#store.listOperations();
      const pushable = operations.filter((operation) =>
        isPushable(operation.status, options.manual),
      );

      if (pushable.length > 0) {
        this.#syncing = true;
        this.#setSnapshot(operations);
      }

      try {
        await this.#pushAll(pushable);
      } catch {
        // 传输层整体失败（超时 / 网络错误 / 服务端 5xx）：这一批标记成
        // `failed` 并保留在队列里。重推是安全的——同一个 operationId 会命中
        // 服务端的幂等行，返回 `already_applied` 而不是重复写（§12.1.1）。
        ok = false;
        await this.#markFailed(pushable);
      }

      try {
        await this.#pullAll();
      } catch {
        ok = false;
      }
    } finally {
      this.#syncing = false;
      this.#busy = false;
      await this.refresh();
    }

    return { ok };
  }

  /**
   * 解决一条冲突。
   *
   * 失败时**抛出**而不是吞掉：调用方（冲突弹层）要就地展示错误行并给出「重试」
   * （§4.9.2 第 7 条），把失败翻译成静默会让用户以为已经处理完了。
   */
  async resolveConflict(conflictId: string, resolution: ConflictResolutionChoice): Promise<void> {
    await this.#transport.resolve(conflictId, resolution);

    // 服务端已经解决：本地为这条冲突排队的操作随之下队。
    const conflicts = await this.#store.listOperations('conflict');
    for (const operation of conflicts) {
      if (operation.conflictId === conflictId) {
        await this.#store.removeOperation(operation.operationId);
      }
    }
    await this.refresh();
  }

  /** 逐个批次推送；批内逐条回写结果。 */
  async #pushAll(operations: readonly PendingOperationRecord[]): Promise<void> {
    for (let index = 0; index < operations.length; index += this.#pushBatchSize) {
      const batch = operations.slice(index, index + this.#pushBatchSize);
      const results = await this.#transport.push(batch.map(toPushOperation));
      const byId = new Map(results.map((result) => [result.operationId, result]));

      for (const operation of batch) {
        const result = byId.get(operation.operationId);
        if (result === undefined) {
          // 服务端漏回这一条：既不能当成功（会丢操作）也不能当失败（会重复写），
          // 保持原状态留给下一轮。
          continue;
        }
        await this.#applyPushResult(operation, result);
      }
    }
  }

  /** 单条 push 结果 → 队列状态。 */
  async #applyPushResult(operation: PendingOperationRecord, result: SyncPushResult): Promise<void> {
    switch (result.status) {
      case 'applied':
      case 'already_applied':
        await this.#store.removeOperation(operation.operationId);
        return;
      case 'conflict':
        await this.#store.updateOperation(operation.operationId, {
          status: 'conflict',
          conflictId: result.conflictId,
          conflictServerVersion: result.serverVersion,
          conflictServerPayload: result.serverPayload,
        });
        return;
      case 'rejected':
        await this.#store.updateOperation(operation.operationId, {
          status: 'rejected',
          rejectReason: result.reason,
        });
        return;
    }
  }

  /** 一批推送整体失败：全部标记为暂时性失败，保留在队列里等下一次重试。 */
  async #markFailed(operations: readonly PendingOperationRecord[]): Promise<void> {
    for (const operation of operations) {
      if (operation.status === 'failed') {
        continue;
      }
      await this.#store.updateOperation(operation.operationId, { status: 'failed' });
    }
  }

  /** 分页拉取增量并逐条落到本地快照。 */
  async #pullAll(): Promise<void> {
    let cursor = await this.#store.readCursor(LOCAL_SYNC_CURSOR_ID);

    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const result = await this.#transport.pull(cursor, this.#pullPageSize);

      for (const change of result.changes) {
        await this.#store.applyRemoteChange(toRemoteChange(change));
      }

      if (result.nextCursor === null) {
        return;
      }
      // 每页都落游标：中途失败时下一轮从这里继续，不会把已应用的一整段重拉一遍。
      cursor = result.nextCursor;
      await this.#store.writeCursor(LOCAL_SYNC_CURSOR_ID, cursor);

      if (result.changes.length < this.#pullPageSize) {
        return;
      }
    }
  }

  /** 由队列算出横幅视图；并通知订阅者。 */
  #setSnapshot(operations: readonly PendingOperationRecord[]): void {
    const pendingCount = operations.filter((operation) => operation.status === 'pending').length;
    const failedCount = operations.filter((operation) => operation.status === 'failed').length;

    // 状态 5/6 按**条目（实体）数**计（§4.9.1 计数口径）：同一实体排了两条操作
    // （例如一次 update 加一次 delete）只算一条。
    const rejected = dedupeByEntity(
      operations.filter((operation) => operation.status === 'rejected'),
    ).map((operation) => ({
      id: entityKey(operation.entityType, operation.entityId),
      name: entityDisplayName(operation),
      reason: operation.rejectReason ?? '服务端未给出原因',
    }));

    const conflicts = dedupeByConflictId(
      operations.filter((operation) => operation.status === 'conflict'),
    ).map(toConflictView);

    this.#snapshot = {
      syncing: this.#syncing,
      pendingCount,
      failedCount,
      rejected,
      conflicts,
    };

    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/** 创建同步引擎。 */
export function createSyncClient(dependencies: SyncClientDependencies): SyncClient {
  return new SyncClient(dependencies);
}

/**
 * 这条状态要不要在这一轮里推。
 *
 * `rejected` 只在手动同步时重推：它是服务端给出的**永久性**结论，
 * 自动重推等于每次切回标签页都打一次注定失败的请求（§4.9.1 的时机纪律）。
 */
function isPushable(status: PendingOperationStatus, manual: boolean): boolean {
  if (status === 'pending' || status === 'failed') {
    return true;
  }
  return status === 'rejected' && manual;
}

/** 队列记录 → push 入参。 */
function toPushOperation(operation: PendingOperationRecord): SyncPushOperation {
  return {
    operationId: operation.operationId,
    entityType: operation.entityType,
    entityId: operation.entityId,
    operationType: operation.operationType,
    baseVersion: operation.baseVersion,
    payload: operation.payload,
  };
}

/** 拉回的变更 → 本地存储入参（时间在这里转成毫秒）。 */
function toRemoteChange(change: SyncPulledChange): RemoteChangeInput {
  return {
    entityType: change.entityType,
    entityId: change.entityId,
    version: change.version,
    deleted: change.deleted,
    payload: change.payload,
    changeAt: Date.parse(change.changeAt),
  };
}

/** 实体键：列表 key 与去重都用它。 */
function entityKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/** 同一实体的多条操作只保留一条（计数按条目算）。 */
function dedupeByEntity(
  operations: readonly PendingOperationRecord[],
): readonly PendingOperationRecord[] {
  const seen = new Map<string, PendingOperationRecord>();
  for (const operation of operations) {
    const key = entityKey(operation.entityType, operation.entityId);
    if (!seen.has(key)) {
      seen.set(key, operation);
    }
  }
  return [...seen.values()];
}

/**
 * 同一冲突只保留一条。
 *
 * 服务端的 `sync_conflicts` 对同一实体只允许一条 `pending`，因此同实体上的
 * 多条操作会命中**同一个** `conflictId`——不去重的话，用户会看到同一条冲突
 * 被数了两次。
 */
function dedupeByConflictId(
  operations: readonly PendingOperationRecord[],
): readonly PendingOperationRecord[] {
  const seen = new Map<string, PendingOperationRecord>();
  for (const operation of operations) {
    const key = operation.conflictId ?? operation.operationId;
    if (!seen.has(key)) {
      seen.set(key, operation);
    }
  }
  return [...seen.values()];
}

/** 队列记录 → 冲突弹层的视图。 */
function toConflictView(operation: PendingOperationRecord): SyncConflictView {
  const serverPayload = operation.conflictServerPayload;

  return {
    conflictId: operation.conflictId ?? '',
    entityName: entityDisplayName(operation),
    local: {
      // 本地这一侧的"最后修改时间"就是入队时刻——它是用户做出这次编辑的时间。
      changedAtLabel: formatTimestamp(operation.createdAt),
      fields: summarizeFields(operation.payload),
    },
    server: {
      changedAtLabel: formatTimestamp(readTimestamp(serverPayload)),
      fields: summarizeFields(serverPayload),
    },
  };
}

/** 实体可读名：优先标题，其次名称，都没有就退化成 id（绝不显示空白标题）。 */
function entityDisplayName(operation: PendingOperationRecord): string {
  for (const key of ['title', 'name']) {
    const value = operation.payload[key];
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return operation.entityId;
}

/** 从 payload 里读一个时间值（`updatedAt` 可能是 ISO 串，也可能是毫秒数）。 */
function readTimestamp(payload: Readonly<Record<string, unknown>> | null): string | number | null {
  if (payload === null) {
    return null;
  }
  const value = payload['updatedAt'] ?? payload['changeAt'];
  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  return null;
}

/**
 * 时间 → 用户时区的可读串。
 *
 * 用 `Intl.DateTimeFormat` 而不是 `toLocaleString()`：后者在缺少 Intl 数据的环境里
 * 会静默退化成"只给日期"，而且不同年度/区域参数的默认形态差异很大。
 */
function formatTimestamp(value: string | number | null): string | null {
  if (value === null) {
    return null;
  }
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(timestamp),
  );
}

/** payload → 最多 3 行关键字段摘要（按 `SUMMARY_FIELDS` 的优先级取）。 */
function summarizeFields(
  payload: Readonly<Record<string, unknown>> | null,
): readonly { readonly label: string; readonly value: string }[] {
  if (payload === null) {
    return [];
  }

  const fields: { readonly label: string; readonly value: string }[] = [];
  for (const [key, label] of SUMMARY_FIELDS) {
    const value = payload[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      // 嵌套对象/数组不进摘要：3 行之内读不完，展开也不该发生在弹层里。
      continue;
    }
    fields.push({ label, value: String(value) });
    if (fields.length >= MAX_SUMMARY_FIELDS) {
      break;
    }
  }
  return fields;
}
