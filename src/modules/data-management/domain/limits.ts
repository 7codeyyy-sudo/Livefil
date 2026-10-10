/**
 * data-management 定值（OPS-002；接口 §13 冻结八定值 + 实现级定值单点）。
 *
 * 契约冻结值（终审 2026-10-09 生效）与实现级定值分组标注——实现级项
 * （带「实现级」注记）随 RD-015 提请预审确认，不混入契约面。
 */

/* ---------------- 契约冻结（八定值 + §13 落值） ---------------- */

/** `formatVersion = 1`（八定值之一）。 */
export const FORMAT_VERSION = 1;

/** 回收区保留期 30 天，逾期自动清除（八定值：retention 30 天）。 */
export const RETENTION_DAYS = 30;

/** 账户撤销窗 7 天（八定值：撤销窗 7 天）。 */
export const DELETION_WINDOW_DAYS = 7;

/** 预览结果 30 分钟内有效（八定值：preview 30 分钟）。 */
export const PREVIEW_TTL_MS = 30 * 60 * 1000;

/** 单页上限 100（八定值：单页上限 100——契约提案行的 1–200 以裁定为准）。 */
export const RECYCLE_PAGE_MAX = 100;
/** 默认页长 100（契约 `?limit=` 默认值）。 */
export const RECYCLE_PAGE_DEFAULT = 100;

/** 限流五条（八定值：限流五条，契约 §13 汇总表逐行落值）。 */
export const RATE_LIMITS = {
  /** `POST /data-exports`：5 次/小时/用户。 */
  exportPerHour: 5,
  /** `POST /data-imports/preview`：10 次/小时/用户。 */
  previewPerHour: 10,
  /** `POST /data-imports/{importId}/confirm`：5 次/小时/用户。 */
  confirmPerHour: 5,
  /** `DELETE /recycle-items`（清空回收区）：10 次/小时/用户。 */
  recycleClearPerHour: 10,
  /** `POST /account/deletion-request`：3 次/天/用户。 */
  deletionPerDay: 3,
} as const;

/* ---------------- 实现级定值（随 RD-015 提请确认） ---------------- */

/**
 * 单条回收区操作（恢复/单删）限流：30 次/小时/用户。
 *
 * 契约只写「三端点均限流更严」未给阈值——取值介于通用读（无限制）与
 * 清空（10/时）之间：行内逐条恢复是正常操作密度，阈值只需挡住脚本化滥用。
 */
export const recycleItemOpPerHour = 30;

/**
 * 导出下载有效期 30 分钟（契约「短期下载地址」未给值——对齐 preview 的
 * 30 分钟时限，同一份「短期」语义只取一个数）。
 */
export const DOWNLOAD_TTL_MS = PREVIEW_TTL_MS;

/** 一小时/一天的毫秒数（限流窗口换算单点）。 */
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** 限流键单点（前缀按用途分域，便于日志与排查识别）。 */
export function rateLimitKey(kind: string, userId: string): string {
  return `data:${kind}:${userId}`;
}
