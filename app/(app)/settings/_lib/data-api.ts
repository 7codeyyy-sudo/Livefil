/**
 * 设置分区 7 的客户端接口（OPS-002；契约 §13 的前端消费面）。
 *
 * 与 `account-api.ts` 同构：薄封装信封、零业务逻辑。`Idempotency-Key`
 * 由调用方生成（每次确认一枚新键、loading 防连点——`sendJson` 的 headers
 * 槽透传）。网络失败不会被同步层入队：`describeFailedWrite` 的白名单不含
 * `/data-*`、`/recycle-items`、`/account/*` 路径。
 */
import { fetchJson, sendJson } from '../../_lib/api-client';
import type { CountKey } from '@/modules/data-management/presentation/data-view.ts';

/** 计数对象（契约 preview 响应字面键 `{ total, 新增, 重复 }`）。 */
export interface CountShape {
  readonly total: number;
  readonly 新增: number;
  readonly 重复: number;
}

export interface ExportCreateResult {
  readonly exportId: string;
  readonly format: 'json' | 'csv';
  readonly formatVersion: number;
}

export interface ExportStatusResult {
  readonly status: 'pending' | 'done' | 'failed';
  readonly downloadUrl?: string;
  readonly fileName: string;
  readonly formatVersion: number;
  readonly expiresAt: string;
}

export interface PreviewResult {
  readonly importId: string;
  readonly formatVersion: number;
  readonly currentFormatVersion: number;
  readonly compatible: boolean;
  readonly exportedAt: string;
  readonly counts: Readonly<Record<CountKey, CountShape>>;
  readonly willClear: number;
}

export interface ConfirmResult {
  readonly added: number;
  readonly skipped: number;
  readonly cleared?: number;
}

export interface RecycleRow {
  readonly entityType: 'task' | 'action' | 'routine' | 'fixed_commitment' | 'expense';
  readonly itemId: string;
  readonly name: string;
  readonly deletedAt: string;
}

export interface RecycleListResult {
  readonly items: readonly RecycleRow[];
  readonly retentionDays: number;
}

const GET_TIMEOUT_MS = 15_000;

/** 创建导出（当前只渲染 JSON 面——CSV 按钮候终审，契约保留 format 参数）。 */
export function startExport(format: 'json' | 'csv'): Promise<{ data: ExportCreateResult }> {
  return sendJson<ExportCreateResult>('POST', '/api/v1/data-exports', { format });
}

/** 读取导出状态（拿 `downloadUrl`）。 */
export function getExportStatus(exportId: string): Promise<{ data: ExportStatusResult }> {
  return fetchJson<ExportStatusResult>(
    `/api/v1/data-exports/${encodeURIComponent(exportId)}`,
    AbortSignal.timeout(GET_TIMEOUT_MS),
  );
}

/** 导入预览（`file`＝导出文件原文，零写入）。 */
export function previewImport(fileText: string): Promise<{ data: PreviewResult }> {
  return sendJson<PreviewResult>('POST', '/api/v1/data-imports/preview', { file: fileText });
}

/** 确认导入（幂等键必带——契约 §1.1）。 */
export function confirmImport(
  importId: string,
  mode: 'merge' | 'replace',
  idempotencyKey: string,
  confirm?: boolean,
): Promise<{ data: ConfirmResult }> {
  return sendJson<ConfirmResult>(
    'POST',
    `/api/v1/data-imports/${encodeURIComponent(importId)}/confirm`,
    confirm === undefined ? { mode } : { mode, confirm },
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

/** 回收区列表（单页上限 100——八定值；服务端已按删除时间倒序）。 */
export function listRecycle(signal: AbortSignal): Promise<{ data: RecycleListResult }> {
  return fetchJson<RecycleListResult>('/api/v1/recycle-items', signal);
}

/** 恢复单条。 */
export function restoreRecycleItem(
  entityType: RecycleRow['entityType'],
  itemId: string,
): Promise<{ data: { readonly restored: boolean } }> {
  return sendJson<{ restored: boolean }>(
    'POST',
    `/api/v1/recycle-items/${encodeURIComponent(entityType)}/${encodeURIComponent(itemId)}/restore`,
  );
}

/** 清空回收区（客户端前置 ConfirmDialog）。 */
export function clearRecycle(): Promise<{ data: { readonly cleared: number } }> {
  return sendJson<{ cleared: number }>('DELETE', '/api/v1/recycle-items');
}
