/**
 * data-management 用例的装配单点（OPS-002；与 `auth-deps.ts` 同构）。
 *
 * 路由只表达业务流转，依赖从这里拿：组合根管「实现的懒加载单例」，本文件管
 * 「用例构造参数的组装」——同一组装配写多遍必然漂移，而数据管理装配的漂移
 * 表现是某个端点少了一层限流或少记一条安全事件。
 *
 * 依赖方向合规：`app/**` 只经组合根取端口（FND-004），不直接引用
 * `src/infrastructure/**` 与模块的 domain/infrastructure。
 */
import {
  CreateExportUseCase,
  DownloadExportUseCase,
  GetExportStatusUseCase,
} from '@/modules/data-management/application/export-use-cases.ts';
import {
  ConfirmImportUseCase,
  PreviewImportUseCase,
} from '@/modules/data-management/application/import-use-cases.ts';
import {
  ClearRecycleUseCase,
  ListRecycleUseCase,
  RemoveRecycleItemUseCase,
  RestoreRecycleItemUseCase,
} from '@/modules/data-management/application/manage-recycle.ts';
import {
  CancelAccountDeletionUseCase,
  RequestAccountDeletionUseCase,
} from '@/modules/data-management/application/request-deletion.ts';

import {
  getAuditLogger,
  getExportStore,
  getImportPreviewStore,
  getRateLimiter,
  getRepositories,
} from '../../composition-root.ts';

/** 导出三件（创建 / 状态 / 下载）——共享同一组依赖形状。 */
function exportDeps() {
  const repositories = getRepositories();
  return {
    reader: repositories.dataExport,
    store: getExportStore(),
    limiter: getRateLimiter(),
    audit: getAuditLogger(),
    now: (): Date => new Date(),
  };
}

export function createExportUseCase(): CreateExportUseCase {
  return new CreateExportUseCase(exportDeps());
}

export function createExportStatusUseCase(): GetExportStatusUseCase {
  return new GetExportStatusUseCase(exportDeps());
}

export function createDownloadExportUseCase(): DownloadExportUseCase {
  return new DownloadExportUseCase(exportDeps());
}

/** 导入两件（预览 / 确认）。 */
function importDeps() {
  const repositories = getRepositories();
  return {
    gateway: repositories.dataImport,
    previews: getImportPreviewStore(),
    limiter: getRateLimiter(),
    audit: getAuditLogger(),
    now: (): Date => new Date(),
  };
}

export function createPreviewImportUseCase(): PreviewImportUseCase {
  return new PreviewImportUseCase(importDeps());
}

export function createConfirmImportUseCase(): ConfirmImportUseCase {
  return new ConfirmImportUseCase(importDeps());
}

/** 回收区四件。 */
export function createRecycleUseCases(): {
  readonly list: ListRecycleUseCase;
  readonly restore: RestoreRecycleItemUseCase;
  readonly remove: RemoveRecycleItemUseCase;
  readonly clear: ClearRecycleUseCase;
} {
  const deps = {
    recycle: getRepositories().recycle,
    limiter: getRateLimiter(),
    audit: getAuditLogger(),
    now: (): Date => new Date(),
  };
  return {
    list: new ListRecycleUseCase(deps),
    restore: new RestoreRecycleItemUseCase(deps),
    remove: new RemoveRecycleItemUseCase(deps),
    clear: new ClearRecycleUseCase(deps),
  };
}

/** 账户删除两件（会话吊销经 identity 仓储端口——结构兼容，组合根已注入）。 */
export function createDeletionUseCases(): {
  readonly request: RequestAccountDeletionUseCase;
  readonly cancel: CancelAccountDeletionUseCase;
} {
  const repositories = getRepositories();
  const deps = {
    deletionRequests: repositories.deletionRequests,
    sessions: repositories.sessions,
    limiter: getRateLimiter(),
    audit: getAuditLogger(),
    now: (): Date => new Date(),
  };
  return {
    request: new RequestAccountDeletionUseCase(deps),
    cancel: new CancelAccountDeletionUseCase(deps),
  };
}
