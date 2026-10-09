/**
 * 导入预览的进程内存存储（OPS-002；契约 preview `importId` 30 分钟时限）。
 *
 * 边界同 `export-store.memory.ts`：短期对象、惰性清扫、单实例口径。
 * `get` 按 **importId + userId 双条件**取——跨用户的 importId 拿不到数据，
 * 与回收区「他人行 404 不泄露存在性」同一纪律。
 */
import type { ImportPreviewStore, StoredPreview } from '../domain/data-ports.ts';
import { PREVIEW_TTL_MS } from '../domain/limits.ts';

export function createInMemoryImportPreviewStore(): ImportPreviewStore {
  const previews = new Map<string, StoredPreview>();

  return {
    put(preview: StoredPreview): void {
      previews.set(preview.importId, preview);
    },
    get(importId: string, userId: string): StoredPreview | undefined {
      const preview = previews.get(importId);
      if (preview === undefined || preview.userId !== userId) {
        return undefined;
      }
      return preview;
    },
    drop(importId: string, userId: string): void {
      const preview = previews.get(importId);
      if (preview !== undefined && preview.userId === userId) {
        previews.delete(importId);
      }
    },
    sweep(now: Date): void {
      const cutoff = now.getTime() - PREVIEW_TTL_MS;
      for (const [id, preview] of previews) {
        if (preview.createdAt.getTime() <= cutoff) {
          previews.delete(id);
        }
      }
    },
  };
}
