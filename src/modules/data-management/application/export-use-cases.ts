/**
 * 导出用例（OPS-002，《接口文档》§13 `POST /data-exports` 与
 * `GET /data-exports/{exportId}`）。
 *
 * ## 为什么先占作业再生成
 *
 * 契约定义了三态（pending/done/failed）与「failed 记安全事件」——把生成放在
 * 「先占位、后执行」的结构里，failed 才是**可到达**的状态：生成失败不炸 POST
 * （作业已占位，状态端点如实呈 failed + 审计事件），而不是让一次数据库读失败
 * 变成 5xx 却没有任何契约面记录。
 *
 * ## 存储边界
 *
 * 作业存进程内存（「短期下载地址」语义；重启即失效——重新导出即可，契约
 * 本就要求失效后重建）。单实例部署与限流的单实例边界同口径（RD-015 披露）。
 */
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';

import type { ExportFormat } from '../domain/export-format.ts';
import {
  CURRENT_FORMAT_VERSION,
  exportFileName,
  newJobId,
  renderExportCsv,
} from '../domain/export-format.ts';
import type { ExportJob, ExportReader, ExportStore, RateLimiter } from '../domain/data-ports.ts';
import { DOWNLOAD_TTL_MS, HOUR_MS, RATE_LIMITS } from '../domain/limits.ts';
import { NotFoundError } from '@/shared/errors/app-error.ts';

import { enforceLimit } from './rate-guard.ts';

/** `POST /data-exports` 响应 data（契约：`{ exportId, format, formatVersion }`）。 */
export interface CreateExportResult {
  readonly exportId: string;
  readonly format: ExportFormat;
  readonly formatVersion: number;
}

/** `GET /data-exports/{exportId}` 响应 data（契约形状，`downloadUrl` 按态可选）。 */
export interface ExportStatusResult {
  readonly status: 'pending' | 'done' | 'failed';
  readonly downloadUrl?: string;
  readonly fileName: string;
  readonly formatVersion: number;
  readonly expiresAt: string;
}

export interface ExportUseCaseDeps {
  readonly reader: ExportReader;
  readonly store: ExportStore;
  readonly limiter: RateLimiter;
  readonly audit: AuditLogger;
  readonly now: () => Date;
}

/** 创建导出（限流 5 次/小时/用户，契约汇总表）。 */
export class CreateExportUseCase {
  readonly #deps: ExportUseCaseDeps;

  constructor(deps: ExportUseCaseDeps) {
    this.#deps = deps;
  }

  async execute(userId: string, format: ExportFormat): Promise<CreateExportResult> {
    const { reader, store, limiter, audit, now } = this.#deps;
    enforceLimit(limiter, 'export', userId, RATE_LIMITS.exportPerHour, HOUR_MS);

    const startedAt = now();
    const exportId = newJobId();
    const fileName = exportFileName(format, CURRENT_FORMAT_VERSION, startedAt.toISOString());
    const job: ExportJob = {
      exportId,
      userId,
      format,
      formatVersion: CURRENT_FORMAT_VERSION,
      fileName,
      contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      status: 'pending',
      content: null,
      createdAt: startedAt,
      expiresAt: new Date(startedAt.getTime() + DOWNLOAD_TTL_MS),
    };
    store.put(job);

    try {
      const file = await reader.dump(userId, startedAt);
      job.content = format === 'csv' ? renderExportCsv(file) : `${JSON.stringify(file, null, 2)}\n`;
      job.status = 'done';
      audit.record({
        type: 'DATA_EXPORTED',
        outcome: 'succeeded',
        anonymousUserId: toAnonymousUserId(userId),
      });
    } catch {
      // 契约：failed 不返回下载地址并记安全事件。吞下原始错误不是掩盖——
      // 它已经以 DATA_EXPORTED/failed 进了审计通道，状态端点把失败如实呈现，
      // 客户端按契约「重新创建导出」而不是盯着一个 5xx。
      job.status = 'failed';
      audit.record({
        type: 'DATA_EXPORTED',
        outcome: 'failed',
        anonymousUserId: toAnonymousUserId(userId),
      });
    }

    return { exportId, format, formatVersion: CURRENT_FORMAT_VERSION };
  }
}

/** 读取导出状态（所有权校验：他人的 exportId 一律 404，不泄露存在性）。 */
export class GetExportStatusUseCase {
  readonly #deps: ExportUseCaseDeps;

  constructor(deps: ExportUseCaseDeps) {
    this.#deps = deps;
  }

  execute(userId: string, exportId: string, now: Date): ExportStatusResult {
    const { store } = this.#deps;
    store.sweep(now);
    const job = store.get(exportId);
    if (job === undefined || job.userId !== userId) {
      throw new NotFoundError('导出任务不存在或已过期');
    }
    const base = {
      status: job.status,
      fileName: job.fileName,
      formatVersion: job.formatVersion,
      expiresAt: job.expiresAt.toISOString(),
    };
    if (job.status !== 'done') {
      // pending / failed 均不带 downloadUrl（契约：failed 不返回下载地址）。
      return base;
    }
    return {
      ...base,
      downloadUrl: `/api/v1/data-exports/${exportId}/download`,
    };
  }
}

/** 下载载荷（所有权 + 到期 + 未完成三态合一：任一不满足即 404）。 */
export interface ExportDownload {
  readonly content: string;
  readonly contentType: string;
  readonly fileName: string;
}

export class DownloadExportUseCase {
  readonly #deps: ExportUseCaseDeps;

  constructor(deps: ExportUseCaseDeps) {
    this.#deps = deps;
  }

  execute(userId: string, exportId: string, now: Date): ExportDownload {
    const { store } = this.#deps;
    store.sweep(now);
    const job = store.get(exportId);
    if (
      job === undefined ||
      job.userId !== userId ||
      job.status !== 'done' ||
      job.content === null
    ) {
      throw new NotFoundError('导出文件不存在或已过期');
    }
    return { content: job.content, contentType: job.contentType, fileName: job.fileName };
  }
}
