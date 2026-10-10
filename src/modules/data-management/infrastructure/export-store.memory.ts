/**
 * 导出作业的进程内存存储（OPS-002；契约「短期下载地址」语义）。
 *
 * ## 边界（如实申报）
 *
 * 作业不落库：`expiresAt`（30 分钟）本就要求过期即弃，落库只会引入「谁来清
 * 过期行」的第二套机制。代价是**进程重启即失效**——按契约「失效后重新创建
 * 导出」即可，无数据损失（导出内容可再生）。与限流的进程内边界同口径：
 * 单实例部署（甲案形态）下语义完整，多实例化时须换共享存储（RD-015 披露）。
 *
 * 过期回收是**惰性**的：每次取用先 `sweep`（与会话 `purgeExpired` 同族——
 * 不为一个 30 分钟生命周期的对象引入 cron）。
 */
import type { ExportJob, ExportStore } from '../domain/data-ports.ts';

export function createInMemoryExportStore(): ExportStore {
  const jobs = new Map<string, ExportJob>();

  return {
    put(job: ExportJob): void {
      jobs.set(job.exportId, job);
    },
    get(exportId: string): ExportJob | undefined {
      return jobs.get(exportId);
    },
    sweep(now: Date): void {
      for (const [id, job] of jobs) {
        if (job.expiresAt.getTime() <= now.getTime()) {
          jobs.delete(id);
        }
      }
    },
  };
}
