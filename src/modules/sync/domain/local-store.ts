/**
 * 本地存储端口（SYNC-002，《详细设计说明书》§5.4、《数据库设计文档》§4.18.1）。
 *
 * ## 它是什么
 *
 * 客户端在浏览器里保存两类东西：**实体快照**（服务端数据的本地副本，供离线读取）
 * 与**待同步队列**（本地写操作，等网络可用时逐条推给服务端）。两者都是「本地真相」，
 * 但寿命不同：快照是服务端数据的缓存，队列是**尚未提交到任何地方**的用户编辑——
 * 后者绝不能因为一次失败的同步而消失（SRS NFR-REL-004）。
 *
 * ## 为什么是端口而不是直接调 IndexedDB
 *
 * 端口放 `domain/`：`modules/<模块>/infrastructure` 被禁止引用 `application`，
 * 端口若定义在应用层，实现它就违规（与 `sync-repository.ts` 同一条既定结论）。
 * 换来的收益是双实现共存——浏览器走 IndexedDB，单测与 SSR 走内存实现。
 *
 * ## 命名冻结
 *
 * 待同步队列的 store 名是 `pending_operations`（§5.4.2 冻结改名：不叫 outbox），
 * 服务端**没有**对应的 `outbox_operations` 表——队列只存在于客户端。
 */
import type { SyncOperationType } from './sync-repository.ts';

/** 实体快照的 store 名（IndexedDB object store）。 */
export const SNAPSHOT_STORE_NAME = 'entity_snapshots';

/** 待同步操作的 store 名。 */
export const PENDING_OPERATION_STORE_NAME = 'pending_operations';

/** 拉取游标的 store 名。 */
export const SYNC_CURSOR_STORE_NAME = 'sync_cursor';

/**
 * 本地单用户场景下固定使用的游标键。
 *
 * 游标是「这台设备同步到哪了」，不是「哪个用户同步到哪了」——本地模式只有一个
 * 数据空间（UI 规范 §4.9.3），因此不需要按键区分。
 */
export const LOCAL_SYNC_CURSOR_ID = 'local';

/**
 * 快照的同步状态。
 *
 * `pending` 表示本地改动尚未被服务端确认：此时 pull 回来的同实体变更**不得**覆盖它
 * （NFR-REL-004：禁止系统自动路径覆盖本地数据）。
 */
export type SyncSnapshotState = 'synced' | 'pending';

/** 一条实体快照。 */
export interface EntitySnapshotRecord {
  /** 契约里的单数 snake_case 类型名（`task` / `routine_step` …）。 */
  readonly entityType: string;
  readonly entityId: string;
  /** 服务端版本；本地新建（尚未推送）时记 `0`。 */
  readonly version: number;
  /** 是否已是墓碑（服务端送达的软删 / 取消）。 */
  readonly deleted: boolean;
  /** 实体字段（camelCase，与 pull 的 payload 同形）。 */
  readonly payload: Readonly<Record<string, unknown>>;
  /** 变更时刻（毫秒）。远端写入用 `changeAt`，本地写入用当前时间。 */
  readonly changeAt: number;
  readonly syncState: SyncSnapshotState;
}

/**
 * 待同步操作的状态。
 *
 * 四态与横幅的六态一一对应，刻意不合并：
 * - `pending`：待推送（横幅「N 条待同步」）；
 * - `failed`：推送时超时 / 网络错误 / 服务端 5xx，**仍待推送**（横幅「同步未完成」）；
 * - `rejected`：服务端明确拒绝，重试也不会变（横幅「同步被拒绝」）；
 * - `conflict`：版本冲突，需要用户二选（横幅「内容与其他设备不一致」）。
 */
export type PendingOperationStatus = 'pending' | 'failed' | 'rejected' | 'conflict';

/** 队列里的一条待同步操作。 */
export interface PendingOperationRecord {
  /** 客户端生成的 UUID；它同时是服务端幂等键的一部分（§12.1.1）。 */
  readonly operationId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly operationType: SyncOperationType;
  /**
   * 期望的服务端版本（CAS 依据）。`null` 表示不做版本校验——
   * `create` 与 `keep_local` 的强制覆盖会用到它。
   */
  readonly baseVersion: number | null;
  /** 待写入的实体字段。 */
  readonly payload: Readonly<Record<string, unknown>>;
  /** 入队时刻（毫秒）。冲突弹层里作为「此设备的版本」的修改时间。 */
  readonly createdAt: number;
  readonly status: PendingOperationStatus;
  /** `rejected` 时服务端给出的可懂原因（供「查看详情」逐行展示）。 */
  readonly rejectReason: string | null;
  readonly conflictId: string | null;
  readonly conflictServerVersion: number | null;
  readonly conflictServerPayload: Readonly<Record<string, unknown>> | null;
}

/**
 * 对一条待同步操作的部分更新。
 *
 * 只允许改「推送结果带来的那几位」：操作内容（类型、payload、baseVersion）一旦入队
 * 就是用户已经表达过的意图，同步层无权改写它。
 */
export interface PendingOperationPatch {
  readonly status: PendingOperationStatus;
  readonly rejectReason?: string | null | undefined;
  readonly conflictId?: string | null | undefined;
  readonly conflictServerVersion?: number | null | undefined;
  readonly conflictServerPayload?: Readonly<Record<string, unknown>> | null | undefined;
}

/**
 * 把一条本地快照标记为「已被服务端确认」的入参（push 成功后调用）。
 *
 * `create` 的本地快照在入队时是 `pending`（本地改动尚未确认）；推送成功后必须
 * 把它转成 `synced` 并写入服务端版本，否则这条快照会永远挡住该实体的后续拉取
 * （`applyRemoteChange` 对 `pending` 一律 `ignored`），形成一条永不更新的本地孤儿。
 */
export interface SnapshotConfirmInput {
  readonly entityType: string;
  readonly entityId: string;
  /** 服务端在 push 结果里返回的新版本。 */
  readonly version: number;
  /** 确认时刻（毫秒），作为快照的 `changeAt`。 */
  readonly changeAt: number;
}

/** 拉取游标记录。 */
export interface SyncCursorRecord {
  readonly id: string;
  /** 不透明游标串（`"<毫秒>:<uuid>"`）；客户端只原样存回，不解析。 */
  readonly value: string;
}

/** 一条从服务端拉回来的变更（已由视图层把 `changeAt` 转成毫秒）。 */
export interface RemoteChangeInput {
  readonly entityType: string;
  readonly entityId: string;
  readonly version: number;
  readonly deleted: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly changeAt: number;
}

/**
 * 应用一条远端变更的结果。
 *
 * 三种结果都要能观测，否则「拉了一页但什么都没发生」与「拉了一页并写了 12 行」
 * 在日志与测试里长得一模一样。
 */
export type ApplyRemoteChangeOutcome = 'applied' | 'ignored' | 'purged';

/**
 * 父级墓碑的级联规则。
 *
 * 《数据库设计文档》§4.18.1 记的缺口：服务端删 `routine` 时**不会**硬删
 * `routine_steps`（它只有软删列，而软删不级联）。因此客户端收到 `routine` 的
 * 墓碑时必须自己把子行收拾掉——否则那些孤儿步骤会永远留在本地。
 */
export interface SyncCascadeRule {
  /** 父实体类型。 */
  readonly parent: string;
  /** 子实体类型。 */
  readonly child: string;
  /** 子实体 payload 里指向父实体的字段名。 */
  readonly childForeignKey: string;
}

export const SYNC_CASCADE_RULES: readonly SyncCascadeRule[] = [
  { parent: 'routine', child: 'routine_step', childForeignKey: 'routineId' },
];

/**
 * 子实体 payload → 父实体 id；无级联规则或读不到时返回 `null`。
 *
 * 只按注册表读，不猜字段名：猜错的后果是把一个无关的实体 id 当成父级，
 * 从而在墓碑到达时误删用户的本地数据。
 */
export function readParentEntityId(
  entityType: string,
  payload: Readonly<Record<string, unknown>>,
): string | null {
  for (const rule of SYNC_CASCADE_RULES) {
    if (rule.child !== entityType) {
      continue;
    }
    const value = payload[rule.childForeignKey];
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return null;
}

/** 某个父实体类型的子实体类型列表。 */
export function childEntityTypesOf(parentType: string): readonly string[] {
  return SYNC_CASCADE_RULES.filter((rule) => rule.parent === parentType).map((rule) => rule.child);
}

/**
 * 本地存储端口。
 *
 * ## 写入纪律：一次读改写必须落在同一个事务里
 *
 * `applyRemoteChange`、`updateOperation` 都要先读后写。若读与写分成两个事务，
 * 两个并发的同步轮次会交错：A 读到「synced」、B 删掉整行、A 再把快照写回去——
 * 被删的内容复活。IndexedDB 的事务是**唯一**能表达这条约束的原语，因此端口
 * 实现必须把它用在每一个读改写方法内（`local-store.indexeddb.ts` 的
 * `runInTransaction`）。
 *
 * ## 幂等
 *
 * `applyRemoteChange` 必须幂等：同一批变更被拉两次不能产生两份状态。
 * 判据是 `(entityType, entityId, version)`——见实现里的 `>=` 比较。
 */
export interface LocalStore {
  /** 读一条实体快照。 */
  readSnapshot(entityType: string, entityId: string): Promise<EntitySnapshotRecord | null>;

  /** 写入（或整体替换）一条实体快照。 */
  putSnapshot(record: EntitySnapshotRecord): Promise<void>;

  /** 列出某一实体类型的全部实体快照（供列表渲染本地未同步项）。 */
  listSnapshots(entityType: string): Promise<readonly EntitySnapshotRecord[]>;

  /**
   * 把一条 `pending` 快照标记为 `synced` 并写入确认版本。
   *
   * 快照不存在、或已经是 `synced` 时**静默忽略**：一次 push 会确认多种操作，
   * 只有本地新建（`create`）才在本地留过 `pending` 快照，其余操作没有快照可确认。
   */
  markSnapshotSynced(input: SnapshotConfirmInput): Promise<void>;

  /** 应用一条远端变更（幂等 upsert；墓碑则清理本地行，含父级级联）。 */
  applyRemoteChange(change: RemoteChangeInput): Promise<ApplyRemoteChangeOutcome>;

  /** 入队一条待同步操作。 */
  enqueueOperation(record: PendingOperationRecord): Promise<void>;

  /** 列出待同步操作；`status` 省略时列出全部（四种状态）。 */
  listOperations(status?: PendingOperationStatus): Promise<readonly PendingOperationRecord[]>;

  /** 按 `operationId` 更新一条操作；不存在时静默忽略。 */
  updateOperation(operationId: string, patch: PendingOperationPatch): Promise<void>;

  /** 移除一条操作（推送成功后）。 */
  removeOperation(operationId: string): Promise<void>;

  /** 读拉取游标；尚未写过时返回 `null`。 */
  readCursor(id: string): Promise<string | null>;

  /** 写拉取游标。 */
  writeCursor(id: string, value: string): Promise<void>;
}
