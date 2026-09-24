/**
 * 同步持久化端口（SYNC-001 拉取 / SYNC-003 写入）。
 *
 * 两个端口放同一个文件：它们描述的是同一份"参与同步的实体集合"，只是方向相反
 * （读变更 / 写操作）。分开会让未来新增一个实体类型时必须同时想起两处。
 *
 * 端口必须放 `domain/`：`modules/<模块>/infrastructure` 被禁止引用 `application`，
 * 端口若定义在应用层，实现它就违规（Phase 2 的既定结论，与 `task-repository.ts` 同）。
 */
import type { PullCursor, SyncChange } from './sync-change.ts';

/** 增量拉取的查询条件。 */
export interface ListChangesOptions {
  /** 游标之后（不含）的变更；首页为 `null`。 */
  readonly after: PullCursor | null;
  /** 变更时刻上界，即 `now - lag`（安全滞后窗口，§12.1.2）。 */
  readonly until: Date;
  /** 单页上限（≤100）。 */
  readonly limit: number;
}

/** 一页变更。 */
export interface SyncChangePage {
  readonly changes: readonly SyncChange[];
  /** 本页最后一条的游标；本页无变更时为 `null`。 */
  readonly nextCursor: string | null;
  /** 是否还有后续变更（本页未取尽）。 */
  readonly hasMore: boolean;
}

export interface SyncRepository {
  /**
   * 按 `(changeAt, id)` 升序返回游标之后的变更。
   *
   * 排序键与游标格式是**同一个契约的两面**，因此不接受排序参数。
   */
  listChanges(userId: string, options: ListChangesOptions): Promise<SyncChangePage>;
}

/** push 的操作类型。`create` 由客户端带上自己的 UUID（离线期间就得有稳定 id）。 */
export const SYNC_OPERATION_TYPES = ['create', 'update', 'delete'] as const;

export type SyncOperationType = (typeof SYNC_OPERATION_TYPES)[number];

/** 单条 push 操作。 */
export interface SyncApplyOperation {
  /** 客户端给出的实体类型字符串；不在契约集合内时由实现判成 `rejected`。 */
  readonly entityType: string;
  readonly entityId: string;
  readonly operationType: SyncOperationType;
  /**
   * 期望的服务端版本（CAS 依据）。`null` 表示**不做版本校验**——
   * 只有 `keep_local` 的强制覆盖会用到它，普通 push 一律带上 `baseVersion`。
   */
  readonly baseVersion: number | null;
  /** 待写入的实体字段（camelCase，与 pull 的 payload 同形）。 */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * 写入结果。
 *
 * `not_found` / `unsupported` 不单列：它们对客户端都是"这条操作做不了"，
 * 用带原因的 `rejected` 表达既满足契约的四种状态，也让原因能回到客户端。
 */
export type SyncApplyOutcome =
  | { readonly outcome: 'applied'; readonly version: number }
  | {
      readonly outcome: 'conflict';
      readonly serverVersion: number;
      readonly serverPayload: Readonly<Record<string, unknown>>;
    }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface SyncApplyPort {
  /**
   * 按乐观并发写入一条操作。
   *
   * **不负责幂等**：占位/快照由幂等端口处理，本端口只在"确认要执行"时被调用。
   */
  apply(userId: string, operation: SyncApplyOperation): Promise<SyncApplyOutcome>;
}
