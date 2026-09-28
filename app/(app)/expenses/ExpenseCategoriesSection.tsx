'use client';

import { useState } from 'react';

import {
  AsyncState,
  Badge,
  Button,
  ConfirmDialog,
  Input,
  LoadingState,
  Skeleton,
  Switch,
} from '@/shared/ui/components';
import type { AsyncQueryState } from '@/shared/ui/components';

import { ApiRequestError } from '../_lib/api-client';
import { createExpenseCategory, updateExpenseCategory } from '../_lib/expense-api';
import type { ExpenseCategoryItem } from '../_lib/expense-api';

import styles from './ExpenseCategoriesSection.module.css';

/** 分类名上限 60 字符（DB `varchar(60)`，A6 明文）。 */
const CATEGORY_NAME_MAX = 60;
/** 条目超过这个数量时在区头提供搜索（A6「条目多时区头提供搜索」）。 */
const SEARCH_THRESHOLD = 6;

export type ExpenseCategoriesSectionProps = {
  readonly state: AsyncQueryState<readonly ExpenseCategoryItem[]>;
  readonly onRetry: () => void;
  /** 新建成功后把新分类并入本地面板状态。 */
  readonly onCreated: (category: ExpenseCategoryItem) => void;
  /** 重命名 / 停用 / 启用成功后替换本地面板状态里的那一项。 */
  readonly onUpdated: (category: ExpenseCategoryItem) => void;
};

/**
 * 开销分类管理区（EXP-001，《UI 页面规范》§5 A6）。
 *
 * ## 对标生活领域管理，但按 FR-051 字面裁剪
 *
 * 形态沿用设置页「生活领域管理」的冻结模式：列表 + 就地重命名 + 新增 inline +
 * 轻确认 + 「显示已停用」恢复。差异是**无排序控件、无颜色选择、不提供删除**：
 * FR-051 的枚举只有新增 / 重命名 / 停用，默认与自定义分类同等只停用、不删除，
 * 这样历史开销的关联永续可解析。
 *
 * ## 「停用」为什么走轻确认
 *
 * 停用＝置 `is_archived`，非破坏性、可恢复，但会让分类从可选列表消失（易误触），
 * 所以给一次轻确认；与设置页归档同一纪律。
 */
export function ExpenseCategoriesSection({
  state,
  onRetry,
  onCreated,
  onUpdated,
}: ExpenseCategoriesSectionProps) {
  return (
    <section className={styles.section} id="expense-categories">
      <h2 className={styles.title}>分类管理</h2>
      <p className={styles.description}>
        分类只服务开销：可以新增、重命名或停用。停用不会删除历史开销，随时可恢复。
      </p>

      <AsyncState
        state={state}
        isEmpty={(items) => items.length === 0}
        errorTitle="分类没能加载"
        errorDescription="数据没能取回来。可以先重试。"
        loading={
          <LoadingState label="正在加载分类">
            <div className={styles.skeleton}>
              <Skeleton />
              <Skeleton />
              <Skeleton />
            </div>
          </LoadingState>
        }
        empty={{
          title: '还没有分类',
          description: '新建一个分类，之后记账时就能选到它。',
        }}
        onRetry={onRetry}
        renderSuccess={(items) => (
          <CategoryManager items={items} onCreated={onCreated} onUpdated={onUpdated} />
        )}
      />
    </section>
  );
}

function CategoryManager({
  items,
  onCreated,
  onUpdated,
}: {
  readonly items: readonly ExpenseCategoryItem[];
  readonly onCreated: (category: ExpenseCategoryItem) => void;
  readonly onUpdated: (category: ExpenseCategoryItem) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = items.filter((item) => !item.isArchived).sort(bySortOrder);
  const archived = items.filter((item) => item.isArchived).sort(bySortOrder);
  const needle = search.trim().toLowerCase();
  const visible =
    needle === '' ? active : active.filter((item) => item.name.toLowerCase().includes(needle));

  async function mutate(task: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : '操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  const archiving =
    archivingId === null ? null : (items.find((item) => item.id === archivingId) ?? null);

  return (
    <div className={styles.manager}>
      {error === null ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {items.length > SEARCH_THRESHOLD ? (
        <Input
          label="搜索分类"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      ) : null}

      <ul className={styles.list}>
        {visible.map((item) => (
          <li key={item.id} className={styles.row}>
            {editingId === item.id ? (
              <div className={styles.inlineForm}>
                <Input
                  label={`重命名「${item.name}」`}
                  maxLength={CATEGORY_NAME_MAX}
                  value={editingName}
                  autoFocus
                  onChange={(event) => {
                    setEditingName(event.target.value);
                  }}
                />
                <div className={styles.inlineActions}>
                  <Button
                    variant="primary"
                    loading={busy}
                    disabled={editingName.trim() === ''}
                    onClick={() => {
                      void mutate(async () => {
                        const { data } = await updateExpenseCategory(item.id, {
                          name: editingName,
                        });
                        onUpdated(data);
                        setEditingId(null);
                        setEditingName('');
                      });
                    }}
                  >
                    保存名称
                  </Button>
                  <Button
                    onClick={() => {
                      setEditingId(null);
                      setEditingName('');
                    }}
                  >
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <span className={styles.name}>{item.name}</span>
                {item.isDefault ? <Badge variant="neutral">默认</Badge> : null}
                <div className={styles.rowActions}>
                  <Button
                    disabled={busy}
                    aria-label={`重命名「${item.name}」`}
                    onClick={() => {
                      setEditingId(item.id);
                      setEditingName(item.name);
                    }}
                  >
                    重命名
                  </Button>
                  <Button
                    disabled={busy}
                    aria-label={`停用「${item.name}」`}
                    onClick={() => {
                      setArchivingId(item.id);
                    }}
                  >
                    停用
                  </Button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>

      <div className={styles.addForm}>
        <Input
          label="新增分类"
          hint="名称最长 60 个字符。"
          maxLength={CATEGORY_NAME_MAX}
          value={newName}
          disabled={busy}
          onChange={(event) => {
            setNewName(event.target.value);
          }}
        />
        <Button
          variant="primary"
          loading={busy}
          disabled={newName.trim() === ''}
          onClick={() => {
            void mutate(async () => {
              const { data } = await createExpenseCategory(newName);
              onCreated(data);
              setNewName('');
            });
          }}
        >
          新增分类
        </Button>
      </div>

      <div className={styles.archivedBlock}>
        <Switch label="显示已停用" checked={showArchived} onChange={setShowArchived} />

        {showArchived ? (
          archived.length === 0 ? (
            <p className={styles.emptyNote}>没有已停用的分类。</p>
          ) : (
            <ul className={styles.list}>
              {archived.map((item) => (
                <li key={item.id} className={styles.row}>
                  <span className={styles.name}>{item.name}</span>
                  <Badge variant="neutral">已停用</Badge>
                  <div className={styles.rowActions}>
                    <Button
                      loading={busy}
                      aria-label={`启用「${item.name}」`}
                      onClick={() => {
                        void mutate(async () => {
                          const { data } = await updateExpenseCategory(item.id, {
                            isArchived: false,
                          });
                          onUpdated(data);
                        });
                      }}
                    >
                      启用
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>

      {/*
        停用走轻确认（A6）：非破坏性、可恢复，但会让分类从可选列表消失。
        用 `destructive` 是为了初始焦点落在「取消」（与设置页归档同一纪律）。
      */}
      <ConfirmDialog
        open={archiving !== null}
        title="停用这个分类？"
        description={
          archiving === null
            ? ''
            : `「${archiving.name}」会从记账的可选列表里移除，已关联的历史开销保留。之后可以在「显示已停用」里恢复。`
        }
        confirmLabel="停用"
        destructive
        pending={busy}
        onCancel={() => {
          setArchivingId(null);
        }}
        onConfirm={() => {
          if (archivingId !== null) {
            void mutate(async () => {
              const { data } = await updateExpenseCategory(archivingId, { isArchived: true });
              onUpdated(data);
              setArchivingId(null);
            });
          }
        }}
      />
    </div>
  );
}

/** 分类按 `sortOrder` 升序（A6 无排序控件，展示沿用服务端顺序）。 */
function bySortOrder(a: ExpenseCategoryItem, b: ExpenseCategoryItem): number {
  return a.sortOrder - b.sortOrder;
}
