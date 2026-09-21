'use client';

/**
 * 生活领域管理分区（IAM-003，《UI 页面规范》v0.16 §5 的分区 1）。
 *
 * ## 为什么这里自己取数，而其它分区不是
 *
 * 另外四个分区编辑的是同一个 `/me` 对象，共用一份草稿；生活领域是**另一份资源**
 * （`GET /life-areas`），有自己的增删改与排序。所以它自带一个取数区，而它的四个
 * 同伴接收草稿绑定。
 *
 * ## 为什么操作后不改用 refetch
 *
 * 每次变更接口都会回传变更后的实体（排序回传整份未归档列表），直接把这些结果
 * 合并进本地列表，界面就不会在每次点击后闪一次加载态。代价是本地列表可能与
 * 服务端漂移——这一点由"所有变更都基于服务端回传的值"压住：本地从不自己推算
 * `version` 或 `sortOrder`。
 */
import { useId, useState } from 'react';

import {
  AsyncState,
  Button,
  ConfirmDialog,
  Input,
  LoadingState,
  Select,
  Skeleton,
  Switch,
  useAsyncQuery,
} from '@/shared/ui/components';
import type { LifeAreaDto } from '@/modules/life-areas/application/life-area-dto.ts';

import {
  LIFE_AREAS_QUERY,
  createLifeArea,
  fetchLifeAreas,
  reorderLifeAreas,
  updateLifeArea,
} from '../../_lib/identity-api';
import type { ApiEnvelope } from '../../_lib/api-client';

import styles from './LifeAreasSection.module.css';
/** 分类色的可选值。与领域层的六枚 key 一一对应（§2.1 分类色族）。 */
const COLOR_OPTIONS = [
  { key: 'blue', label: '蓝' },
  { key: 'green', label: '绿' },
  { key: 'amber', label: '琥珀' },
  { key: 'violet', label: '紫' },
  { key: 'teal', label: '青' },
  { key: 'rose', label: '玫' },
] as const;

const DEFAULT_COLOR_KEY = 'blue';

function bySortOrder(a: LifeAreaDto, b: LifeAreaDto): number {
  return a.sortOrder - b.sortOrder;
}

/** 领域列表的加载轮廓：三行，每行一条。 */
function LifeAreasSkeleton() {
  return (
    <div className={styles.skeleton}>
      <Skeleton />
      <Skeleton />
      <Skeleton />
    </div>
  );
}

export function LifeAreasSection() {
  const titleId = useId();
  const { state, refetch } = useAsyncQuery<ApiEnvelope<{ items: readonly LifeAreaDto[] }>>({
    queryKey: LIFE_AREAS_QUERY.queryKey,
    queryFn: (signal) => fetchLifeAreas(signal),
  });

  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.title}>
        生活领域
      </h2>
      <p className={styles.description}>
        领域用来给任务与开销分类。归档不会删除内容，随时可以恢复。
      </p>

      <AsyncState
        state={state}
        isEmpty={(envelope) => envelope.data.items.length === 0}
        errorTitle="生活领域没能加载"
        errorDescription="数据没能取回来。可以先重试。"
        loading={
          <LoadingState label="正在加载生活领域">
            <LifeAreasSkeleton />
          </LoadingState>
        }
        empty={{
          title: '还没有生活领域',
          description: '新增一个领域，之后给任务分类时就能选到它。',
        }}
        onRetry={refetch}
        renderSuccess={(envelope) => <LifeAreaManager initial={envelope.data.items} />}
      />
    </section>
  );
}

function LifeAreaManager({ initial }: { readonly initial: readonly LifeAreaDto[] }) {
  const [items, setItems] = useState<readonly LifeAreaDto[]>(initial);
  const [showArchived, setShowArchived] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColorKey, setNewColorKey] = useState<string>(DEFAULT_COLOR_KEY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = items.filter((item) => !item.isArchived).sort(bySortOrder);
  const archived = items.filter((item) => item.isArchived).sort(bySortOrder);

  /**
   * 执行一次变更。
   *
   * `busy` 在**动作**上挡重复提交，而不是只依赖按钮的禁用态：排序、归档这些
   * 操作各自会改变列表，两次并发的结果取决于返回顺序，界面就再也对不上了。
   */
  async function mutate(task: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  /** 用服务端回传的实体替换本地那一项（从不本地推算 version / sortOrder）。 */
  function replaceOne(updated: LifeAreaDto): void {
    setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  function handleCreate(): void {
    void mutate(async () => {
      const { data } = await createLifeArea({ name: newName, colorKey: newColorKey });
      setItems((current) => [...current, data]);
      setNewName('');
      setNewColorKey(DEFAULT_COLOR_KEY);
    });
  }

  function handleRename(id: string): void {
    void mutate(async () => {
      const { data } = await updateLifeArea(id, { name: editingName });
      replaceOne(data);
      setEditingId(null);
      setEditingName('');
    });
  }

  function handleColorChange(id: string, colorKey: string): void {
    void mutate(async () => {
      const { data } = await updateLifeArea(id, { colorKey });
      replaceOne(data);
    });
  }

  function handleArchive(id: string): void {
    void mutate(async () => {
      const { data } = await updateLifeArea(id, { isArchived: true });
      replaceOne(data);
      setArchivingId(null);
    });
  }

  function handleRestore(id: string): void {
    void mutate(async () => {
      const { data } = await updateLifeArea(id, { isArchived: false });
      // 恢复保持它原来的 `sortOrder`（即回到归档前的位置）。若恰与别的领域
      // 同序，显示顺序由 `sort` 的稳定性决定；下一次排序操作会把全部序号
      // 重写成 0..n-1，重复即自行消除。
      replaceOne(data);
    });
  }

  function handleMove(index: number, offset: -1 | 1): void {
    const target = index + offset;
    if (target < 0 || target >= active.length) {
      return;
    }

    const orderedIds = active.map((item) => item.id);
    const moved = orderedIds[index];
    const swapped = orderedIds[target];
    if (moved === undefined || swapped === undefined) {
      return;
    }
    orderedIds[index] = swapped;
    orderedIds[target] = moved;

    void mutate(async () => {
      const { data } = await reorderLifeAreas(orderedIds);
      // 接口只回传**未归档**列表，所以归档项要原样保留。
      setItems((current) => [...current.filter((item) => item.isArchived), ...data.items]);
    });
  }

  const archiving =
    archivingId === null ? null : (items.find((item) => item.id === archivingId) ?? null);
  const isCreateDisabled = newName.trim() === '';

  return (
    <div className={styles.manager}>
      {error === null ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <ul className={styles.list}>
        {active.map((item, index) => (
          <li key={item.id} className={styles.row}>
            {editingId === item.id ? (
              <div className={styles.inlineForm}>
                <Input
                  label={`重命名「${item.name}」`}
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
                      handleRename(item.id);
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

                <Select
                  label={`「${item.name}」的分类色`}
                  value={item.colorKey}
                  disabled={busy}
                  onChange={(event) => {
                    handleColorChange(item.id, event.target.value);
                  }}
                >
                  {COLOR_OPTIONS.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </Select>

                <div className={styles.rowActions}>
                  <Button
                    disabled={busy || index === 0}
                    aria-label={`把「${item.name}」上移`}
                    onClick={() => {
                      handleMove(index, -1);
                    }}
                  >
                    上移
                  </Button>
                  <Button
                    disabled={busy || index === active.length - 1}
                    aria-label={`把「${item.name}」下移`}
                    onClick={() => {
                      handleMove(index, 1);
                    }}
                  >
                    下移
                  </Button>
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
                    aria-label={`归档「${item.name}」`}
                    onClick={() => {
                      setArchivingId(item.id);
                    }}
                  >
                    归档
                  </Button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>

      <div className={styles.addForm}>
        <Input
          label="新增领域"
          hint="名称最长 60 个字符。"
          value={newName}
          disabled={busy}
          onChange={(event) => {
            setNewName(event.target.value);
          }}
        />
        <Select
          label="分类色"
          value={newColorKey}
          disabled={busy}
          onChange={(event) => {
            setNewColorKey(event.target.value);
          }}
        >
          {COLOR_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </Select>
        <Button variant="primary" loading={busy} disabled={isCreateDisabled} onClick={handleCreate}>
          新增领域
        </Button>
      </div>

      <div className={styles.archivedBlock}>
        <Switch label="显示已归档" checked={showArchived} onChange={setShowArchived} />

        {showArchived ? (
          archived.length === 0 ? (
            <p className={styles.emptyNote}>没有已归档的领域。</p>
          ) : (
            <ul className={styles.list}>
              {archived.map((item) => (
                <li key={item.id} className={styles.row}>
                  <span className={styles.name}>{item.name}</span>
                  <span className={styles.archivedTag}>已归档</span>
                  <div className={styles.rowActions}>
                    <Button
                      loading={busy}
                      aria-label={`恢复「${item.name}」`}
                      onClick={() => {
                        handleRestore(item.id);
                      }}
                    >
                      恢复
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>

      {/*
        归档走轻确认（§5：「归档经轻确认（非破坏性、可恢复）」）。用 `destructive`
        是为了让初始焦点落在「取消」——归档虽然可恢复，但它会让领域从可选列表里
        消失，误触的代价不小。确认按钮文案写清"归档"而不是"删除"。
      */}
      <ConfirmDialog
        open={archiving !== null}
        title="归档这个生活领域？"
        description={
          archiving === null
            ? ''
            : `「${archiving.name}」会从可选列表里移除，已关联的内容保留。之后可以在「显示已归档」里恢复。`
        }
        confirmLabel="归档"
        destructive
        pending={busy}
        onCancel={() => {
          setArchivingId(null);
        }}
        onConfirm={() => {
          if (archivingId !== null) {
            handleArchive(archivingId);
          }
        }}
      />
    </div>
  );
}
