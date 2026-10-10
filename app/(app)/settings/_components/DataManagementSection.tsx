'use client';

/**
 * 设置分区 7「数据管理」（OPS-002，《UI 页面规范》v0.26 分区 7；FR-090/091/093）。
 *
 * ## 区块边界（本批实现面）
 *
 * - **导出**：双态说明行（`GET /me` 的 mode 驱动）+「导出 JSON」直接下载
 *   （非破坏，不经确认）；版本号双呈现＝文件名（服务端 `fileName`）+ Toast。
 * - **导入**：选文件 → 预览（零写入）→ 三按钮（合并 primary / 覆盖 danger
 *   + ConfirmDialog / 取消）；兼容判定读契约 `compatible` 字段，版本不一致
 *   **禁用而非移除**两个导入按钮（UI 不发明规则）；确认失败展示冻结回滚文案。
 * - **回收区**：说明行（retention 已按八定值回填 30 天）+ 列表（恢复行内按钮）
 *   + 清空（ConfirmDialog）。列表不引入分页（UI-005 挂账）。
 * - **删除块**（按类型清空/清空全部）**本批不渲染**：冻结契约 §13 无对应端点
 *   且四类数据与冻结文案冲突——总监 2026-10-09 裁定「本批不做」，
 *   缺口与文案冲突在 RD-015 披露候契约增补（不放假按钮纪律）。
 *
 * ## 冻结文案与组合文案的分界
 *
 * 「」内为 v0.26 冻结句逐字使用；无冻结句的状态行（预览标签、确认弹窗、
 * 恢复/清空 Toast）为实现组合文案，随 RD-015 清单披露。
 */
import { useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';

import {
  countRows,
  mergeSummary,
  recycleTypeLabel,
} from '@/modules/data-management/presentation/data-view.ts';
import { Button, ConfirmDialog, EmptyState, useAsyncQuery, useToast } from '@/shared/ui/components';

import { ApiRequestError } from '../../_lib/api-client';
import { SettingsSection } from '../_components/SettingsSection';
import {
  clearRecycle,
  confirmImport,
  getExportStatus,
  listRecycle,
  previewImport,
  restoreRecycleItem,
  startExport,
} from '../_lib/data-api';
import type { PreviewResult, RecycleListResult, RecycleRow } from '../_lib/data-api';
import styles from './DataManagementSection.module.css';

/** 部署形态双态说明行（v0.26 分区 7 冻结句）。 */
const EXPORT_HINT = {
  local: '本地数据仅保存在本环境，建议定期导出备份。',
  cloud: '云端模式 · 数据按账号隔离保存在云端，可随时导出备份。',
} as const;

/** 回收区说明行（retention＝八定值 30 天回填）。 */
const RECYCLE_HINT = '回收区条目保留 30 天，逾期自动清除。';

/** 非阻塞错误行的统一取句（服务端 message 优先，网络错误给可操作话）。 */
function message(err: unknown): string {
  if (err instanceof ApiRequestError) {
    return err.message;
  }
  return '网络异常，请稍后再试。';
}

interface Selection {
  readonly fileName: string;
  readonly importId: string;
  readonly preview: PreviewResult;
}

export function DataManagementSection({ mode }: { readonly mode: 'local' | 'cloud' }) {
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ---- 导出 ---- */
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  /* ---- 导入 ---- */
  const [reading, setReading] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);

  /* ---- 回收区：`useAsyncQuery` 取数原语（§4.7 三态 + 手动重试）；
         版本号进 queryKey——恢复/清空后 +1 即重取（hook 的既有机制，
         不在 effect 里手写 setState）。 ---- */
  const [recycleVersion, setRecycleVersion] = useState(0);
  const recycleQuery = useAsyncQuery<RecycleListResult>({
    queryKey: ['recycle', String(recycleVersion)],
    queryFn: async (signal) => (await listRecycle(signal)).data,
  });
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [recycleActionError, setRecycleActionError] = useState<string | null>(null);

  function bumpRecycle(): void {
    setRecycleVersion((version) => version + 1);
  }

  async function doExport(): Promise<void> {
    if (exporting) {
      return;
    }
    setExporting(true);
    setExportError(null);
    try {
      const { data: job } = await startExport('json');
      const { data: status } = await getExportStatus(job.exportId);
      if (status.status !== 'done' || status.downloadUrl === undefined) {
        setExportError(
          status.status === 'failed' ? '导出失败，请重试。' : '导出仍在进行，请稍后重试。',
        );
        return;
      }
      // attachment 响应头让浏览器直接下载、不离开本页。
      window.location.assign(status.downloadUrl);
      toast.success(`已导出 JSON（格式版本 v${String(status.formatVersion)}）`);
    } catch (err) {
      setExportError(message(err));
    } finally {
      setExporting(false);
    }
  }

  async function onFileSelected(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // 立刻清空 value：同一个文件修好后要能再选中（change 不触发的坑）。
    event.target.value = '';
    if (file === undefined) {
      return;
    }
    setReading(true);
    setPreviewError(null);
    setImportError(null);
    setSelection(null);
    try {
      const text = await file.text();
      const { data } = await previewImport(text);
      setSelection({ fileName: file.name, importId: data.importId, preview: data });
    } catch (err) {
      // 预览阶段零写入——没有东西回滚，只给服务端那句解析/校验错误。
      setPreviewError(message(err));
    } finally {
      setReading(false);
    }
  }

  function resetSelection(): void {
    setSelection(null);
    setPreviewError(null);
    setImportError(null);
    setImporting(false);
  }

  async function doConfirm(mode: 'merge' | 'replace'): Promise<void> {
    if (selection === null || importing) {
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const key = globalThis.crypto.randomUUID();
      const { data } = await confirmImport(
        selection.importId,
        mode,
        key,
        mode === 'replace' ? true : undefined,
      );
      toast.success(`已导入：新增 ${String(data.added)} 条`);
      resetSelection();
    } catch (err) {
      // 冻结失败态：回滚文案 + 一行原因（错误原因来自服务端 message，不显示堆栈）。
      setImportError(message(err));
    } finally {
      setImporting(false);
      setReplaceOpen(false);
    }
  }

  async function doRestore(row: RecycleRow): Promise<void> {
    if (restoringId !== null) {
      return;
    }
    setRestoringId(row.itemId);
    setRecycleActionError(null);
    try {
      await restoreRecycleItem(row.entityType, row.itemId);
      toast.success('已恢复');
      bumpRecycle();
    } catch (err) {
      setRecycleActionError(message(err));
    } finally {
      setRestoringId(null);
    }
  }

  async function doClear(): Promise<void> {
    if (clearing) {
      return;
    }
    setClearing(true);
    setRecycleActionError(null);
    try {
      await clearRecycle();
      toast.success('回收区已清空');
      bumpRecycle();
    } catch (err) {
      setRecycleActionError(message(err));
    } finally {
      setClearing(false);
      setClearOpen(false);
    }
  }

  const preview = selection?.preview ?? null;
  const mergeSum = preview === null ? null : mergeSummary(preview.counts);
  const recycleRows: readonly RecycleRow[] =
    recycleQuery.state.status === 'success' ? recycleQuery.state.data.items : [];

  return (
    <SettingsSection title="数据管理" description="导出、导入与回收区。">
      {errorLine(exportError)}

      {/* ---- 导出（双态说明行 + 直接下载） ---- */}
      <p className={styles.hint}>{EXPORT_HINT[mode]}</p>
      <div className={styles.actions}>
        <Button type="button" variant="primary" loading={exporting} onClick={() => void doExport()}>
          导出 JSON
        </Button>
      </div>

      {/* ---- 导入（选文件 → 预览 → 三按钮） ---- */}
      <div className={styles.block}>
        <h3 className={styles.blockTitle}>导入</h3>
        <input
          ref={fileInputRef}
          className={styles.fileInput}
          type="file"
          accept=".json,application/json"
          aria-label="选择导出文件"
          onChange={(event) => void onFileSelected(event)}
        />
        {reading ? <p className={styles.status}>正在解析并生成预览…</p> : null}
        {errorLine(previewError)}

        {preview !== null && selection !== null ? (
          <div className={styles.preview}>
            <dl className={styles.metaList}>
              <div>
                <dt>文件</dt>
                <dd>{selection.fileName}</dd>
              </div>
              <div>
                <dt>格式版本</dt>
                <dd>
                  {`v${String(preview.formatVersion)}（当前 v${String(preview.currentFormatVersion)}）`}
                </dd>
              </div>
              <div>
                <dt>导出时间</dt>
                <dd className={styles.time}>
                  {new Date(preview.exportedAt).toLocaleString('zh-CN')}
                </dd>
              </div>
            </dl>

            {!preview.compatible ? (
              // 冻结句模板（X/Y 由契约字段驱动，UI 不发明兼容规则）。
              <p className={styles.warning} role="alert">
                {`文件格式版本 ${String(preview.formatVersion)} 与当前 ${String(preview.currentFormatVersion)} 不一致。`}
              </p>
            ) : null}

            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">类型</th>
                  <th scope="col">条数</th>
                  <th scope="col">新增</th>
                  <th scope="col">重复</th>
                </tr>
              </thead>
              <tbody>
                {countRows(preview.counts).map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    <td>{row.counts.total}</td>
                    <td>{row.counts.新增}</td>
                    <td>{row.counts.重复}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {mergeSum !== null ? (
              <p className={styles.summary}>
                {`将新增 ${String(mergeSum.added)} 条 / 跳过重复 ${String(mergeSum.repeated)} 条`}
              </p>
            ) : null}

            <div className={styles.actions}>
              <Button
                type="button"
                variant="primary"
                loading={importing}
                disabled={!preview.compatible}
                onClick={() => void doConfirm('merge')}
              >
                合并导入
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={!preview.compatible}
                onClick={() => setReplaceOpen(true)}
              >
                覆盖导入
              </Button>
              <Button type="button" variant="ghost" onClick={resetSelection}>
                取消
              </Button>
            </div>

            {importError !== null ? (
              <div className={styles.failure} role="alert">
                <p className={styles.failureTitle}>导入失败，数据已回滚到导入前状态。</p>
                <p className={styles.failureReason}>{importError}</p>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => fileInputRef.current?.click()}
                >
                  重新选择文件
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ---- 回收区 ---- */}
      <div className={styles.block}>
        <h3 className={styles.blockTitle}>回收区</h3>
        <p className={styles.hint}>{RECYCLE_HINT}</p>
        {errorLine(recycleActionError)}
        {recycleQuery.state.status === 'loading' ? (
          <p className={styles.status}>正在加载回收区…</p>
        ) : recycleQuery.state.status === 'error' ? (
          errorLine(recycleQuery.state.error.message, () => recycleQuery.refetch())
        ) : recycleRows.length === 0 ? (
          <EmptyState
            title="回收区是空的"
            description="删除的内容会先进这里，保留期内可以恢复回来。"
          />
        ) : (
          <ul className={styles.recycleList}>
            {recycleRows.map((row) => (
              <li key={`${row.entityType}:${row.itemId}`} className={styles.recycleRow}>
                <span className={styles.badge}>{recycleTypeLabel(row.entityType)}</span>
                <span className={styles.recycleName}>{row.name === '' ? '—' : row.name}</span>
                <time className={styles.time} dateTime={row.deletedAt}>
                  {new Date(row.deletedAt).toLocaleString('zh-CN')}
                </time>
                <Button
                  type="button"
                  loading={restoringId === row.itemId}
                  onClick={() => void doRestore(row)}
                >
                  恢复
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.actions}>
          <Button
            type="button"
            variant="danger"
            disabled={recycleRows.length === 0}
            onClick={() => setClearOpen(true)}
          >
            清空回收区
          </Button>
        </div>
      </div>

      {/* 危险确认：覆盖导入（初始焦点「取消」由 §4.5 ConfirmDialog 承担） */}
      <ConfirmDialog
        open={replaceOpen}
        title="覆盖导入？"
        description={
          preview === null
            ? '将用导入文件覆盖当前数据。'
            : `将用导入文件覆盖当前的任务、目标、执行记录、例程、开销与复盘。现有数据进入回收区，保留 30 天可恢复（将覆盖 ${String(preview.willClear)} 条）。`
        }
        confirmLabel="覆盖并导入"
        destructive
        pending={importing}
        onCancel={() => setReplaceOpen(false)}
        onConfirm={() => void doConfirm('replace')}
      />

      {/* 危险确认：清空回收区（永久删除） */}
      <ConfirmDialog
        open={clearOpen}
        title="清空回收区？"
        description="回收区中的全部条目将被永久删除，删除后无法恢复。"
        confirmLabel="永久删除"
        destructive
        pending={clearing}
        onCancel={() => setClearOpen(false)}
        onConfirm={() => void doClear()}
      />
    </SettingsSection>
  );
}

/** 内联错误行（可选重试——回收区取数失败给重试，动作失败只陈述）。 */
function errorLine(text: string | null, retry?: () => void): ReactNode {
  if (text === null) {
    return null;
  }
  return (
    <p className={styles.errorLine} role="alert">
      {text}
      {retry !== undefined ? (
        <>
          {' '}
          <button type="button" className={styles.retry} onClick={retry}>
            重试
          </button>
        </>
      ) : null}
    </p>
  );
}
