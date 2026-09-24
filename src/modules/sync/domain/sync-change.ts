/**
 * 同步增量的领域类型与游标编码（SYNC-001，《接口文档》§12.1.2、《数据库设计文档》§4.18）。
 *
 * ## 为什么游标是 `(changeAt, id)` 而不是单纯的 `changeAt`
 *
 * `updated_at` 只精确到微秒且同一事务内多条写入常常落在同一时刻，只用时间做游标
 * 会让"同一毫秒内排在后面的行"被下一轮跳过（与任务列表游标同一个理由）。
 * 复合键把比较变成行值比较 `(change_at, id) > (游标)`，顺序因此完全确定。
 *
 * ## 为什么对客户端不透明
 *
 * 格式写在这里、由 `encodePullCursor` / `decodePullCursor` 成对维护。客户端只原样
 * 回传——一旦客户端开始解析它（例如自己拼时间戳），服务端换实现就等于破坏契约。
 */

/**
 * 参与同步的实体类型。
 *
 * 用**单数 snake_case**（与接口文档 §12.1.2 示例里的 `"task"` 一致），而不是表名：
 * 表名是持久化细节，客户端不该从 `entityType` 反推出库表结构。
 */
export const SYNC_ENTITY_TYPES = [
  'life_area',
  'goal',
  'action',
  'task',
  'routine',
  'routine_step',
  'schedule_block',
  'fixed_commitment',
  'execution_log',
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

/** 判定 `entityType` 是否在契约集合内（push 用它把未知类型逐条判成 `rejected`）。 */
export function isSyncEntityType(value: string): value is SyncEntityType {
  return (SYNC_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * 一条变更。
 *
 * `deleted` 为真即**墓碑**：行本身仍在（软删 / 取消），客户端据此清理本地行。
 * `life_areas` / `goals` / `execution_logs` 按裁定二没有墓碑语义，`deleted` 恒为 false。
 */
export interface SyncChange {
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  /** 服务端版本；追加式表（`execution_logs`）没有版本列，恒为 1。 */
  readonly version: number;
  readonly deleted: boolean;
  /** 实体快照（camelCase、不含 `userId`），与 `GET` 端点的 DTO 口径同源。 */
  readonly payload: Readonly<Record<string, unknown>>;
  /** 变更时刻：`coalesce(updated_at, created_at)`；追加式表即 `created_at`。 */
  readonly changeAt: Date;
}

/** 不透明拉取游标：`(changeAt, id)` 的复合键。 */
export interface PullCursor {
  readonly changeAtMs: number;
  readonly id: string;
}

/** 编码：`"<changeAt 毫秒>:<uuid>"`（§12.1.2 的冻结格式）。 */
export function encodePullCursor(cursor: PullCursor): string {
  return `${String(cursor.changeAtMs)}:${cursor.id}`;
}

/** uuid 的形态（8-4-4-4-12 十六进制）。只做形状校验，不查存在性。 */
const CURSOR_PATTERN = /^(\d{1,16}):([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/;

/**
 * 解码游标；形状不合法返回 `null`（调用方转 400）。
 *
 * 不抛异常：客户端把别的分页端点的游标贴过来是常见的调用错误，它属于
 * `VALIDATION_ERROR`，用返回值表达比用异常类型表达更直接。
 */
export function decodePullCursor(value: string): PullCursor | null {
  const matched = CURSOR_PATTERN.exec(value);
  if (matched === null) {
    return null;
  }
  const changeAtMs = Number(matched[1]);
  const id = matched[2];
  if (id === undefined || !Number.isSafeInteger(changeAtMs)) {
    return null;
  }
  return { changeAtMs, id };
}
