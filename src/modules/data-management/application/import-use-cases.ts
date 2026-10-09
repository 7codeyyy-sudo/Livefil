/**
 * 导入用例（OPS-002，《接口文档》§13 preview / confirm）。
 *
 * ## 两段职责
 *
 * preview＝**零写入**解析与体检（结构校验 + 兼容判定 + 分类型计数 +
 * `willClear`），产出 30 分钟有效的 `importId`；confirm＝**单事务**落库
 * （merge 自然幂等 / replace 软删进回收区 + 覆盖写，失败整笔回滚）。
 * 幂等编排（`Idempotency-Key` 占位/重放/失败释放）在路由层经
 * `withIdempotency` 完成——与 tasks 端点同一编排，不另造一套。
 *
 * ## 为什么 preview 的解析校验停在结构层
 *
 * 字段级兜底交给 DB 约束 + 事务回滚：导出 schema 随七张表演进，逐字段固化
 * 会让「导出加一列」变成两处同步（漂移点）。解析只锁对象/数组/UUID 主键，
 * 足以在预览阶段拦下「拿错文件/手改坏的文件」；更深的错误在 confirm 以
 * 「失败已回滚」的契约文案兜住（PM-005 B1② 冻结失败态）。
 */
import { ValidationError, NotFoundError } from '@/shared/errors/app-error.ts';
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';

import type {
  ImportGateway,
  ImportPreviewStore,
  ImportTypeCount,
  RateLimiter,
} from '../domain/data-ports.ts';
import { CURRENT_FORMAT_VERSION, newJobId } from '../domain/export-format.ts';
import { HOUR_MS, RATE_LIMITS } from '../domain/limits.ts';
import { fileCompatibility, parseExportFile } from './data-schemas.ts';
import { enforceLimit } from './rate-guard.ts';

/** preview 响应 data（契约 §13：双视角计数 + 兼容判定驱动字段）。 */
export interface PreviewImportResult {
  readonly importId: string;
  readonly formatVersion: number;
  readonly currentFormatVersion: number;
  readonly compatible: boolean;
  readonly exportedAt: string;
  /** 分类型计数（merge 视角：每类型 `{ total, 新增, 重复 }`）。 */
  readonly counts: Readonly<Record<CountKey, ImportTypeCount>>;
  /** replace 视角：将被覆盖进回收区的现有条数（契约 `willClear`）。 */
  readonly willClear: number;
}

type CountKey =
  'tasks' | 'goals' | 'executionLogs' | 'routines' | 'expenses' | 'reviews' | 'settings';

/** confirm 响应 data（契约 `{ added, skipped, cleared? }`——`cleared` 仅 replace 给出）。 */
export type ConfirmImportResult =
  | { readonly added: number; readonly skipped: number }
  | { readonly added: number; readonly skipped: number; readonly cleared: number };

export interface ImportUseCaseDeps {
  readonly gateway: ImportGateway;
  readonly previews: ImportPreviewStore;
  readonly limiter: RateLimiter;
  readonly audit: AuditLogger;
  readonly now: () => Date;
}

/** 导入预览（限流 10 次/小时/用户）。 */
export class PreviewImportUseCase {
  readonly #deps: ImportUseCaseDeps;

  constructor(deps: ImportUseCaseDeps) {
    this.#deps = deps;
  }

  async execute(userId: string, fileText: string): Promise<PreviewImportResult> {
    const { gateway, previews, limiter, now } = this.#deps;
    enforceLimit(limiter, 'preview', userId, RATE_LIMITS.previewPerHour, HOUR_MS);

    const file = parseExportFile(fileText);
    const inspection = await gateway.inspect(userId, file);
    const createdAt = now();

    previews.sweep(createdAt);
    const importId = newJobId();
    previews.put({
      importId,
      userId,
      file,
      compatible: fileCompatibility(file),
      createdAt,
    });

    return {
      importId,
      formatVersion: file.formatVersion,
      currentFormatVersion: CURRENT_FORMAT_VERSION,
      compatible: file.formatVersion <= CURRENT_FORMAT_VERSION,
      exportedAt: file.exportedAt,
      counts: inspection.counts,
      willClear: inspection.willClear,
    };
  }
}

/** 确认导入（限流 5 次/小时/用户；幂等键编排在路由层）。 */
export class ConfirmImportUseCase {
  readonly #deps: ImportUseCaseDeps;

  constructor(deps: ImportUseCaseDeps) {
    this.#deps = deps;
  }

  async execute(
    userId: string,
    importId: string,
    mode: 'merge' | 'replace',
  ): Promise<ConfirmImportResult> {
    const { gateway, previews, limiter, audit, now } = this.#deps;
    enforceLimit(limiter, 'confirm', userId, RATE_LIMITS.confirmPerHour, HOUR_MS);

    const at = now();
    previews.sweep(at);
    const preview = previews.get(importId, userId);
    if (preview === undefined) {
      // 30 分钟时限（八定值）或跨用户不可见，均归一到同一句可操作文案。
      throw new NotFoundError('导入预览不存在或已过期，请重新选择文件');
    }
    if (!preview.compatible) {
      // 契约：formatVersion > 当前 ⇒ confirm 一律 400（UI 已按 compatible 禁用，
      // 此处是服务端级双保险——绕过 UI 的直调同样被拒）。
      throw new ValidationError('文件格式版本高于当前版本，无法导入');
    }

    try {
      const outcome =
        mode === 'merge'
          ? await gateway.merge(userId, preview.file, at)
          : await gateway.replace(userId, preview.file, at);

      audit.record({
        type: 'DATA_IMPORTED',
        outcome: 'succeeded',
        anonymousUserId: toAnonymousUserId(userId),
      });

      // 同一 importId 不允许二次消费：确认成功即作废预览（契约未明说，取
      // 「一次预览一次确认」——重复确认 404 引导重新预览，天然防双写）。
      previews.drop(importId, userId);

      if (mode === 'replace') {
        return { added: outcome.added, skipped: outcome.skipped, cleared: outcome.cleared };
      }
      return { added: outcome.added, skipped: outcome.skipped };
    } catch (error) {
      audit.record({
        type: 'DATA_IMPORTED',
        outcome: 'failed',
        anonymousUserId: toAnonymousUserId(userId),
      });
      throw error;
    }
  }
}
