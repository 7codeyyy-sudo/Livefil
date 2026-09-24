/**
 * 同步冲突的领域类型与端口（SYNC-004，《接口文档》§12、§12.1.3、
 * 《数据库设计文档》§4.14）。
 *
 * ## 冲突是怎么产生的
 *
 * push 的 CAS（`baseVersion` 对不上服务端当前版本）失败即冲突：客户端离线期间
 * 改的是旧版本，服务端已经不是它以为的样子。此时**不能**静默覆盖，也不能静默丢弃，
 * 而是记一行 `sync_conflicts` 交给用户二选。
 *
 * ## conflictId 为什么稳定
 *
 * 同一实体只允许一条 `pending`（部分唯一索引 `sync_conflicts_pending_unique`）。
 * 客户端重发同一条操作时命中同一行，`conflictId` 因此不变——否则用户界面上正在
 * 确认的那个冲突会凭空换号。
 */
import type { SyncEntityType } from './sync-change.ts';

/**
 * 解决方式。
 *
 * `manual_merge` 保留取值与端点语义但本批不实现（§12.1.3：P0 只交付前两种）——
 * 枚举里留着它，是为了让"顺延"这件事在类型上可见，而不是等实现时再做一次接口变更。
 */
export const CONFLICT_RESOLUTIONS = ['keep_server', 'keep_local', 'manual_merge'] as const;

export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

/** 一条冲突记录。 */
export interface SyncConflict {
  readonly id: string;
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  /** 客户端的待同步版本；客户端未提供时为 `null`。 */
  readonly localVersion: number | null;
  /** 服务端当前版本（用户二选时展示）。 */
  readonly serverVersion: number;
  /** 本地待同步内容；未提供时为 `null`。 */
  readonly localPayload: Readonly<Record<string, unknown>> | null;
  /** 服务端当前内容。 */
  readonly serverPayload: Readonly<Record<string, unknown>>;
  readonly status: 'pending' | 'resolved';
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  /** 乐观并发版本：`resolve` 的写入以它为准，避免两个请求同时解决同一条。 */
  readonly version: number;
}

/** 记录冲突所需的内容（由 push 的 CAS 失败路径提供）。 */
export interface RecordConflictInput {
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  readonly localVersion: number | null;
  readonly serverVersion: number;
  readonly localPayload: Readonly<Record<string, unknown>> | null;
  readonly serverPayload: Readonly<Record<string, unknown>>;
}

export interface SyncConflictRepository {
  /**
   * 记录冲突；同一实体已有待处理记录时**刷新其内容并复用同一行**。
   *
   * 复用而不是新建：部分唯一索引不允许第二条 `pending`，而且"当前待处理的冲突"
   * 本来就该是唯一一条——历史冲突随 `resolved` 状态自然沉淀。
   */
  record(userId: string, input: RecordConflictInput): Promise<SyncConflict>;

  /** 按 id 读取；不存在或不属于该用户一律 `null`（不泄露存在性）。 */
  findById(userId: string, conflictId: string): Promise<SyncConflict | null>;

  /**
   * 置为已解决（`status='resolved'` + `resolved_at`）。
   *
   * 只对仍处于 `pending` 的行生效：返回 `null` 表示没有发生写入（已被并发解决），
   * 调用方据此返回 409 而不是假装成功。
   */
  markResolved(userId: string, conflictId: string): Promise<SyncConflict | null>;
}
