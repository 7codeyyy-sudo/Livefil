'use client';

import { useMemo, useState } from 'react';

import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  Skeleton,
  useAsyncQuery,
  useCursorListQuery,
  useToast,
} from '@/shared/ui/components';
import type { AsyncQueryState } from '@/shared/ui/components';

import { ApiRequestError, fetchJson } from '../_lib/api-client';
import {
  createExpenseCategory,
  deleteExpense,
  EMPTY_EXPENSE_FILTER,
  fetchExpenseById,
  fetchExpenseCategories,
  formatMinorToHuman,
  hasActiveFilter,
  restoreExpense,
} from '../_lib/expense-api';
import type { ExpenseCategoryItem, ExpenseItem, ExpenseListFilter } from '../_lib/expense-api';
import { fetchProfile } from '../_lib/identity-api';
import { fetchLifeAreas, makeExpensesQueryFn, type GoalItem } from '../_lib/queries';
import { ExpenseCategoriesSection } from './ExpenseCategoriesSection';
import { ExpenseFormDrawer } from './ExpenseFormDrawer';
import { ExpenseSelect } from './ExpenseSelect';
import type { SelectGroup } from './ExpenseSelect';

import styles from './ExpensesPanel.module.css';

/** 记账抽屉的两种初值：新建，或编辑某一笔。 */
type FormState =
  { readonly mode: 'create' } | { readonly mode: 'edit'; readonly expense: ExpenseItem };

/**
 * 开销页（EXP-001~004，《UI 页面规范》§5 A1~A6）。
 *
 * ## 布局（自上而下）
 *
 * 固定「记一笔」入口（在筛选条之上，不随列表滚动消失）→ 筛选条 → 列表（四态 +
 * 游标「加载更多」）→ 页内分类管理区。记账与编辑共用右侧 Drawer。
 *
 * ## 离线边界
 *
 * 列表首页合并本地待同步项（`makeExpensesQueryFn`）；删除不支持离线——请求失败
 * 时明确提示、行不移除、也不弹撤销 Toast（接口 §9 已声明该限制）。
 */
export function ExpensesPanel() {
  const [filter, setFilter] = useState<ExpenseListFilter>(EMPTY_EXPENSE_FILTER);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExpenseItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 已软删、等待撤销或已被服务端移除的行 id（本地即时移出列表）。 */
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());

  const toast = useToast();
  const filterActive = hasActiveFilter(filter);

  const list = useCursorListQuery<ExpenseItem>({
    queryKey: [
      'expenses',
      'list',
      filter.from,
      filter.to,
      filter.categoryId,
      filter.lifeAreaId,
      filter.goalId,
    ],
    queryFn: makeExpensesQueryFn(filter),
  });

  const categoriesQuery = useAsyncQuery({
    queryKey: ['expense-categories', 'all'],
    queryFn: (signal) => fetchExpenseCategories(signal, true),
  });
  const areasQuery = useAsyncQuery({
    queryKey: ['life-areas', 'expense-filter'],
    queryFn: (signal) => fetchLifeAreas(signal),
  });
  const goalsQuery = useAsyncQuery({
    queryKey: ['goals', 'expense-filter'],
    queryFn: (signal) =>
      fetchJson<{ readonly items: readonly GoalItem[] }>(
        '/api/v1/goals?status=active&limit=50',
        signal,
      ).then((envelope) => envelope.data.items),
  });
  const profileQuery = useAsyncQuery({
    queryKey: ['me', 'expense-currency'],
    queryFn: (signal) => fetchProfile(signal),
  });

  // 分类的本地增量 = 服务端结果 + 「新增 / 改过」的覆盖。刻意**不**用 effect 把
  // 异步结果抄进 state：React 19 的 set-state-in-effect 规则禁止那种级联渲染
  // （同 `use-today-label.ts` 的取舍），改为在渲染期派生。
  const [addedCategories, setAddedCategories] = useState<readonly ExpenseCategoryItem[]>([]);
  const [editedCategories, setEditedCategories] = useState<
    ReadonlyMap<string, ExpenseCategoryItem>
  >(new Map());

  const serverCategories =
    categoriesQuery.state.status === 'success' ? categoriesQuery.state.data : null;
  const categories = useMemo(() => {
    const applyEdit = (item: ExpenseCategoryItem) => editedCategories.get(item.id) ?? item;
    const merged = (serverCategories ?? []).map(applyEdit);
    const known = new Set(merged.map((item) => item.id));
    return [...merged, ...addedCategories.filter((item) => !known.has(item.id)).map(applyEdit)];
  }, [serverCategories, editedCategories, addedCategories]);
  // 分区与抽屉都读这份合并结果：新建 / 改名立刻可见，不必整页重新取数。
  const categoriesState = useMemo<AsyncQueryState<readonly ExpenseCategoryItem[]>>(
    () =>
      categoriesQuery.state.status === 'success'
        ? { status: 'success', data: categories }
        : categoriesQuery.state,
    [categoriesQuery.state, categories],
  );

  const listItems = list.state.status === 'success' ? list.state.items : null;

  // 「最近使用」的取数源永远是**无筛选首页**（A3：筛选态不得以筛选结果推导）。
  // 用一条 queryKey 恒定的独立查询承载它：切换筛选不会重置它，因此不会被筛选
  // 结果污染；仅在无筛选时随增删刷新（见 `refreshLists`）。
  const recentQuery = useCursorListQuery<ExpenseItem>({
    queryKey: ['expenses', 'recent-source'],
    queryFn: makeExpensesQueryFn(EMPTY_EXPENSE_FILTER),
  });

  const recentCategoryIds = useMemo(() => {
    const items = recentQuery.state.status === 'success' ? recentQuery.state.items : null;
    if (items === null) {
      return [];
    }
    const ids: string[] = [];
    for (const item of items) {
      if (item.categoryId !== '' && !ids.includes(item.categoryId)) {
        ids.push(item.categoryId);
      }
      if (ids.length >= 3) {
        break;
      }
    }
    return ids;
  }, [recentQuery.state]);

  const categoryNameById = useMemo(
    () => new Map(categories.map((item) => [item.id, item.name])),
    [categories],
  );
  const defaultCurrency =
    profileQuery.state.status === 'success' ? profileQuery.state.data.data.currencyCode : 'CNY';

  const openManageCategories = () => {
    document.getElementById('expense-categories')?.scrollIntoView({ behavior: 'smooth' });
  };

  /** 列表增删后刷新；「最近使用」源只在无筛选时跟着刷（筛选态下保持冻结）。 */
  const refreshLists = () => {
    list.refetch();
    if (!filterActive) {
      recentQuery.refetch();
    }
  };

  const addCategory = (category: ExpenseCategoryItem) => {
    setAddedCategories((current) => [...current, category]);
  };

  const handleCreateCategory = async (name: string): Promise<ExpenseCategoryItem | null> => {
    try {
      const { data } = await createExpenseCategory(name);
      addCategory(data);
      toast.success('已新建分类');
      return data;
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '新建分类失败，请稍后重试');
      return null;
    }
  };

  const replaceCategory = (updated: ExpenseCategoryItem) => {
    setEditedCategories((current) => new Map(current).set(updated.id, updated));
  };

  const handleRestore = async (deleted: ExpenseItem) => {
    try {
      await restoreExpense(deleted.id, deleted.version);
      setRemovedIds((current) => {
        const next = new Set(current);
        next.delete(deleted.id);
        return next;
      });
      toast.success('已恢复');
      refreshLists();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '恢复失败，请稍后重试');
    }
  };

  const handleDelete = async () => {
    const target = deleteTarget;
    if (target === null) {
      return;
    }
    setDeleting(true);
    try {
      const { data } = await deleteExpense(target.id);
      setRemovedIds((current) => new Set(current).add(target.id));
      setDeleteTarget(null);
      if (!filterActive) {
        recentQuery.refetch();
      }
      // 撤销随真实消费者接线（§4.5）；带操作的成功 Toast 8s 后自动关闭。
      toast.success('已删除一笔开销', {
        action: { label: '撤销', onClick: () => void handleRestore(data) },
      });
    } catch (error) {
      // 离线时删除不支持：明确提示失败，行**不得**从列表移除，也不弹撤销 Toast。
      toast.error(error instanceof ApiRequestError ? error.message : '删除失败，请稍后重试');
    } finally {
      setDeleting(false);
    }
  };

  /**
   * 编辑撞 409 时取服务端当前行（交给抽屉渲染「服务器上的版本」与「保留此设备版本」
   * 要用的 `version`）。`GET /expenses/{id}` 是第 8 项随批勘误补上的实体路径，
   * 因此这里不再绕列表首页；返回 `null` 只表示这次读取失败（超时 / 断网 / 5xx）。
   */
  const resolveServerExpense = (expenseId: string): Promise<ExpenseItem | null> =>
    fetchExpenseById(expenseId, new AbortController().signal);

  const visibleItems =
    listItems === null ? null : listItems.filter((item) => !removedIds.has(item.id));

  return (
    <section className={styles.section}>
      <div className={styles.actionsBar}>
        <Button
          variant="primary"
          onClick={() => {
            setFormState({ mode: 'create' });
          }}
        >
          记一笔
        </Button>
      </div>

      <FilterBar
        filter={filter}
        categories={categories}
        areas={areasQuery.state.status === 'success' ? areasQuery.state.data : []}
        goals={goalsQuery.state.status === 'success' ? goalsQuery.state.data : []}
        onChange={setFilter}
        onManageCategories={openManageCategories}
      />

      {list.state.status === 'loading' ? (
        <div className={styles.skeleton}>
          <Skeleton />
          <Skeleton width="90%" />
          <Skeleton width="95%" />
        </div>
      ) : null}

      {list.state.status === 'error' ? (
        <ErrorState
          title="开销列表加载失败"
          description="数据没能取回来。可以先重试。"
          action={
            <Button variant="primary" onClick={list.refetch}>
              重试
            </Button>
          }
        />
      ) : null}

      {visibleItems !== null && visibleItems.length === 0 ? (
        filterActive ? (
          <EmptyState
            title="没有符合条件的开销"
            description="换一组筛选条件，或清除筛选看全部记录。"
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setFilter(EMPTY_EXPENSE_FILTER);
                }}
              >
                清除筛选
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="还没有开销记录"
            description="记下第一笔，之后按分类和时间查看。"
            action={
              <Button
                variant="primary"
                onClick={() => {
                  setFormState({ mode: 'create' });
                }}
              >
                记一笔
              </Button>
            }
          />
        )
      ) : null}

      {list.state.status === 'success' && visibleItems !== null && visibleItems.length > 0 ? (
        <>
          <ul className={styles.list}>
            {visibleItems.map((item) => (
              <li key={item.id} className={styles.row}>
                <button
                  type="button"
                  className={styles.rowMain}
                  onClick={() => {
                    setFormState({ mode: 'edit', expense: item });
                  }}
                >
                  <span className={styles.amount}>
                    {formatMinorToHuman(item.amountMinor)} {item.currencyCode}
                  </span>
                  <span className={styles.rowMeta}>
                    {categoryNameById.get(item.categoryId) ?? '未分类'} · {item.occurredOn}
                    {item.note === null ? '' : ` · ${item.note}`}
                  </span>
                </button>
                <div className={styles.rowActions}>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setFormState({ mode: 'edit', expense: item });
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      setDeleteTarget(item);
                    }}
                  >
                    删除
                  </Button>
                </div>
              </li>
            ))}
          </ul>

          {list.state.loadMoreError !== null ? (
            <p className={styles.loadMoreError} role="alert">
              上一页没能加载完。
              <Button variant="ghost" onClick={list.loadMore}>
                重试
              </Button>
            </p>
          ) : list.state.hasMore ? (
            <div className={styles.loadMoreRow}>
              <Button
                variant="secondary"
                loading={list.state.isLoadingMore}
                onClick={list.loadMore}
              >
                加载更多
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      <ExpenseCategoriesSection
        state={categoriesState}
        onRetry={categoriesQuery.refetch}
        onCreated={addCategory}
        onUpdated={replaceCategory}
      />

      {formState === null ? null : (
        <ExpenseFormDrawer
          expense={formState.mode === 'edit' ? formState.expense : null}
          categories={categories}
          defaultCurrencyCode={defaultCurrency}
          recentCategoryIds={recentCategoryIds}
          onClose={() => {
            setFormState(null);
          }}
          onSaved={() => {
            const wasEdit = formState.mode === 'edit';
            setFormState(null);
            toast.success(wasEdit ? '已保存' : '已记一笔');
            refreshLists();
          }}
          onCreateCategory={handleCreateCategory}
          resolveServerExpense={resolveServerExpense}
          onStale={refreshLists}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这笔开销？"
        description="删除这笔开销？删除后短时间内可撤销。"
        confirmLabel="删除"
        destructive
        pending={deleting}
        onCancel={() => {
          setDeleteTarget(null);
        }}
        onConfirm={() => void handleDelete()}
      />
    </section>
  );
}

/** 筛选条：日期范围 / 分类 / 生活领域 / 目标（窄屏纵折，各自可清空）。 */
function FilterBar({
  filter,
  categories,
  areas,
  goals,
  onChange,
  onManageCategories,
}: {
  readonly filter: ExpenseListFilter;
  readonly categories: readonly ExpenseCategoryItem[];
  readonly areas: readonly { readonly id: string; readonly name: string }[];
  readonly goals: readonly GoalItem[];
  readonly onChange: (next: ExpenseListFilter) => void;
  readonly onManageCategories: () => void;
}) {
  const update = (patch: Partial<ExpenseListFilter>) => {
    onChange({ ...filter, ...patch });
  };

  const categoryGroups: readonly SelectGroup[] = [
    {
      label: '默认分类',
      options: categories
        .filter((item) => item.isDefault && !item.isArchived)
        .map((item) => ({ value: item.id, label: item.name })),
    },
    {
      label: '自定义',
      options: categories
        .filter((item) => !item.isDefault && !item.isArchived)
        .map((item) => ({ value: item.id, label: item.name })),
    },
  ];

  return (
    <div className={styles.filterBar}>
      <Input
        label="起始日期"
        type="date"
        value={filter.from}
        onChange={(event) => {
          update({ from: event.target.value });
        }}
      />
      <Input
        label="结束日期"
        type="date"
        value={filter.to}
        onChange={(event) => {
          update({ to: event.target.value });
        }}
      />
      <ExpenseSelect
        label="分类"
        searchable
        searchLabel="搜索分类"
        placeholder="全部分类"
        value={filter.categoryId}
        groups={categoryGroups}
        onChange={(next) => {
          update({ categoryId: next });
        }}
        footer={
          <Button variant="ghost" onClick={onManageCategories}>
            管理分类
          </Button>
        }
      />
      <ExpenseSelect
        label="生活领域"
        searchable
        searchLabel="搜索生活领域"
        placeholder="全部领域"
        value={filter.lifeAreaId}
        groups={[
          { label: '', options: areas.map((area) => ({ value: area.id, label: area.name })) },
        ]}
        onChange={(next) => {
          update({ lifeAreaId: next });
        }}
      />
      <ExpenseSelect
        label="目标"
        searchable
        searchLabel="搜索目标"
        placeholder="全部目标"
        value={filter.goalId}
        groups={[
          { label: '', options: goals.map((goal) => ({ value: goal.id, label: goal.name })) },
        ]}
        onChange={(next) => {
          update({ goalId: next });
        }}
      />
      {hasActiveFilter(filter) ? (
        <div className={styles.clearFilter}>
          <Button variant="ghost" onClick={() => onChange(EMPTY_EXPENSE_FILTER)}>
            清除筛选
          </Button>
        </div>
      ) : null}
    </div>
  );
}
