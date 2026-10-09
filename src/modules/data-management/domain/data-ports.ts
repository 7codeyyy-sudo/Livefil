/**
 * data-management 领域端口（OPS-002；《概要设计》§4.5——外部依赖经接口接入）。
 *
 * 端口在领域层、实现在基础设施层、装配在组合根：与仓库其余模块同一形态。
 * `ImportGateway` 把「读侧体检 + 写侧事务」合为一个端口，是因为两者必须共享
 * 同一张表集合的列白名单与引用修复规则——拆成两个端口会让「预览说会清 3 条」
 * 与「实际清了 4 条」这种漂移成为可能。
 */
import type { ExportFile } from './export-format.ts';

/** 回收区条目（契约 §13 回收区节：类型 + 名称摘要 + 删除时间）。 */
export interface RecycleItem {
  readonly entityType: RecycleEntityType;
  readonly itemId: string;
  readonly name: string;
  readonly deletedAt: Date;
}

/**
 * 回收区类型全集（契约范围＝有 `deleted_at` 写入路径的软删类型）：
 * `actions`/`tasks`/`routines`/`fixed_commitments`/`expenses`
 * （《数据库设计》§4.18.1(3) 墓碑分类表；`routine_steps` 随父级级联不单列）。
 */
export type RecycleEntityType = 'task' | 'action' | 'routine' | 'fixed_commitment' | 'expense';

export const RECYCLE_ENTITY_TYPES: readonly RecycleEntityType[] = [
  'task',
  'action',
  'routine',
  'fixed_commitment',
  'expense',
];

/** 导入结果计数（契约响应 `{ added, skipped, cleared? }`）。 */
export interface ImportOutcome {
  readonly added: number;
  readonly skipped: number;
  /** replace 模式进回收区的陈旧行数；merge 恒 0（契约 `cleared?` 可选位）。 */
  readonly cleared: number;
}

/**
 * 预览的分类型计数（契约 §13 preview 响应字面形状 `{ total, 新增, 重复 }`——
 * 键名按契约原样落中文字面，不做英文化改写；UI 冻结句「将新增 N 条 / 跳过
 * 重复 M 条」即读自这两个键）。
 */
export interface ImportTypeCount {
  readonly total: number;
  readonly 新增: number;
  readonly 重复: number;
}

/** 预览体检结果（契约 preview 响应的计数面）。 */
export interface ImportInspection {
  readonly counts: Readonly<
    Record<
      'tasks' | 'goals' | 'executionLogs' | 'routines' | 'expenses' | 'reviews' | 'settings',
      ImportTypeCount
    >
  >;
  /** replace 将软删进回收区的现有条数（可回收三类的陈旧行；契约 `willClear`）。 */
  readonly willClear: number;
}

/**
 * 导入网关：体检（零写入）与两个写入模式（各自单事务）。
 *
 * `merge` 按实体 id 自然幂等（同文件二次导入第二次全跳过）；`replace` 对
 * 可回收类型把陈旧行软删进回收区、文件行按 id 覆盖写，失败整事务回滚
 * （契约「导入失败可回滚」）。
 */
export interface ImportGateway {
  inspect(userId: string, file: ExportFile): Promise<ImportInspection>;
  merge(userId: string, file: ExportFile, now: Date): Promise<ImportOutcome>;
  replace(userId: string, file: ExportFile, now: Date): Promise<ImportOutcome>;
}

/** 导出读侧：把该用户的七类数据汇成导出文件（只读）。 */
export interface ExportReader {
  dump(userId: string, now: Date): Promise<ExportFile>;
}

/** 回收区仓储（跨类型五表，全部按 userId 作用域）。 */
export interface RecycleRepository {
  list(userId: string): Promise<readonly RecycleItem[]>;
  /** 恢复软删行；不存在/非本人/已恢复 ⇒ false（调用方转 404，不泄露存在性）。 */
  restore(
    userId: string,
    entityType: RecycleEntityType,
    itemId: string,
    now: Date,
  ): Promise<boolean>;
  /** 单条永久删除；不存在/非本人 ⇒ false（404）。 */
  remove(userId: string, entityType: RecycleEntityType, itemId: string): Promise<boolean>;
  /** 清空回收区（全部类型），返回物理删除条数。 */
  clear(userId: string): Promise<number>;
}

/**
 * 账户删除请求仓储（契约 §13 删除面）。
 *
 * `request` 幂等：活跃请求存在时返回既有行、不叠新行（实现语义，RD-015 披露）。
 */
export interface DeletionRequestRepository {
  getActive(
    userId: string,
    now: Date,
  ): Promise<{ readonly requestedAt: Date; readonly purgeAt: Date } | null>;
  request(
    userId: string,
    requestedAt: Date,
    purgeAt: Date,
  ): Promise<{ readonly requestedAt: Date; readonly purgeAt: Date }>;
  /** 撤销活跃请求；无活跃请求 ⇒ false（调用方仍按契约回 200 幂等）。 */
  cancel(userId: string, now: Date): Promise<boolean>;
}

/** 导出作业存储（进程内存实现——「短期下载」语义见 RD-015 边界披露）。 */
export interface ExportJob {
  readonly exportId: string;
  readonly userId: string;
  readonly format: 'json' | 'csv';
  readonly formatVersion: number;
  readonly fileName: string;
  readonly contentType: string;
  /** `pending` → 生成 → `done`；生成失败 → `failed`（契约三态）。 */
  status: 'pending' | 'done' | 'failed';
  content: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface ExportStore {
  put(job: ExportJob): void;
  get(exportId: string): ExportJob | undefined;
  /** 惰性清扫过期作业（取用时顺手做，不引 cron）。 */
  sweep(now: Date): void;
}

/** 预览暂存（30 分钟有效，契约 `importId` 时限）。 */
export interface StoredPreview {
  readonly importId: string;
  readonly userId: string;
  readonly file: ExportFile;
  readonly compatible: boolean;
  readonly createdAt: Date;
}

export interface ImportPreviewStore {
  put(preview: StoredPreview): void;
  /** 按 importId + userId 双条件取（跨用户不可见，同回收区 404 口径）。 */
  get(importId: string, userId: string): StoredPreview | undefined;
  /** 确认成功后作废（一次预览一次确认，防同一 importId 二次消费）。 */
  drop(importId: string, userId: string): void;
  sweep(now: Date): void;
}

/**
 * 限流端口（本模块自持的结构化副本——不跨模块 import identity 的领域类型，
 * 组合根以同一进程级单例做结构赋值注入，见 RD-015 装配说明）。
 */
export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): boolean;
}
