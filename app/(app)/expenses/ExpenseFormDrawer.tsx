'use client';

import { useState } from 'react';

import {
  Badge,
  Button,
  ConflictDialog,
  Drawer,
  Input,
  Textarea,
  useAsyncQuery,
} from '@/shared/ui/components';
import type { ConflictVersionView } from '@/shared/ui/components';

import { ApiRequestError } from '../_lib/api-client';
import {
  createExpense,
  fetchGoalOptions,
  formatMinorToHuman,
  isAmountTyping,
  parseHumanToMinor,
  updateExpense,
} from '../_lib/expense-api';
import type {
  ExpenseCategoryItem,
  ExpenseItem,
  ExpenseWriteInput,
  GoalOptions,
} from '../_lib/expense-api';
import { fetchLifeAreas, localCalendarDate } from '../_lib/queries';
import { ExpenseSelect } from './ExpenseSelect';
import type { SelectGroup } from './ExpenseSelect';

import styles from './ExpenseFormDrawer.module.css';

/** 币种：第一阶段默认人民币，可扩展（FR-050）。 */
const CURRENCY_OPTIONS = ['CNY', 'USD', 'EUR', 'JPY', 'HKD', 'GBP'] as const;

/** 支付方式的常用取值（`paymentMethod` 是 ≤40 字符自由文本，这里只给常用项）。 */
const PAYMENT_METHOD_OPTIONS = ['现金', '微信', '支付宝', '银行卡', '信用卡', '其他'] as const;

const EMPTY_GOAL_OPTIONS: GoalOptions = { goals: [], actions: [] };

export type ExpenseFormDrawerProps = {
  /** `null` 表示新建；给出实体表示编辑（回填原值与 `version`）。 */
  readonly expense: ExpenseItem | null;
  readonly categories: readonly ExpenseCategoryItem[];
  /** 用户设置里的币种（无设置时由调用方给 CNY）。 */
  readonly defaultCurrencyCode: string;
  /** 最近使用分类 id（由无筛选首页缓存推导，可能为空）。 */
  readonly recentCategoryIds: readonly string[];
  readonly onClose: () => void;
  /** 保存成功（新建或编辑）后刷新列表。 */
  readonly onSaved: () => void;
  /** 行内新建分类：成功返回新分类供自动选中，失败返回 `null`。 */
  readonly onCreateCategory: (name: string) => Promise<ExpenseCategoryItem | null>;
  /** 冲突时取服务端当前行；取不到返回 `null`（见 `fetchExpenseForConflict` 的取舍）。 */
  readonly resolveServerExpense: (expenseId: string) => Promise<ExpenseItem | null>;
  /**
   * 撞 409（服务端已领先）时通知调用方重新取列表。
   *
   * 列表里的那一行此刻带着**旧 `version`**，不刷新的话用户下次编辑必然再撞一次，
   * 直到手动刷新页面为止——所以这条通知不是可选装饰。
   */
  readonly onStale: () => void;
};

/**
 * 记账 / 编辑开销抽屉（EXP-002，《UI 页面规范》§5 A1~A3）。
 *
 * ## 为什么新建与编辑共用一个组件
 *
 * A2 明说「编辑字段同 A2」：两者是**同一张表单**的两种初值。拆成两个组件会让
 * 字段次序、必填标识、金额校验各维护一份，漂移只是时间问题。差异只有标题、
 * 初值与提交方法（POST / PATCH）。
 *
 * ## 金额为什么在提交层才换算
 *
 * UI 收的是「36.50」这种人类金额，提交前经 `parseHumanToMinor` 用**字符串运算**
 * 换成最小货币单位整数串；全程不碰 `parseFloat` / `Number`（见 `expense-api.ts`）。
 *
 * ## 已知取舍
 *
 * 「可搜索选择」由既有 `ExpenseSelect`（原生 Select + 搜索输入）承担；
 * 「关联目标或行动」的行动项需要逐目标取详情（接口无行动集合端点），仅在
 * 展开「更多信息」后才拉取，避免打开抽屉就发 N+1 请求。
 */
export function ExpenseFormDrawer({
  expense,
  categories,
  defaultCurrencyCode,
  recentCategoryIds,
  onClose,
  onSaved,
  onCreateCategory,
  resolveServerExpense,
  onStale,
}: ExpenseFormDrawerProps) {
  const isEdit = expense !== null;

  const [amount, setAmount] = useState(() =>
    expense === null ? '' : formatMinorToHuman(expense.amountMinor),
  );
  const [currency, setCurrency] = useState(expense?.currencyCode ?? defaultCurrencyCode);
  // 分类选择：`null` 表示「用户还没选」，此时按 A3 口径在渲染期派生出预选值
  // （最近使用优先 → 默认分类首项）。用派生而不是 effect 回填，是因为分类是异步
  // 到达的，而 React 19 的 set-state-in-effect 规则禁止在 effect 里同步 setState。
  const [categoryChoice, setCategoryChoice] = useState<string | null>(() =>
    expense === null ? null : expense.categoryId,
  );
  const categoryId = categoryChoice ?? pickDefaultCategory(categories, recentCategoryIds) ?? '';
  const [occurredOn, setOccurredOn] = useState(() => expense?.occurredOn ?? localCalendarDate());
  const [paymentMethod, setPaymentMethod] = useState(expense?.paymentMethod ?? '');
  const [note, setNote] = useState(expense?.note ?? '');
  const [lifeAreaId, setLifeAreaId] = useState(expense?.lifeAreaId ?? '');
  const [goalId, setGoalId] = useState(expense?.goalId ?? '');
  const [actionId, setActionId] = useState(expense?.actionId ?? '');
  const [moreOpen, setMoreOpen] = useState(false);

  const [amountError, setAmountError] = useState<string | undefined>(undefined);
  const [categoryError, setCategoryError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 409 冲突：待保存的值 + **真取到的**服务端当前行（两版都拿得出才开浮层）。 */
  const [conflict, setConflict] = useState<{
    readonly input: ExpenseWriteInput;
    readonly server: ExpenseItem;
  } | null>(null);

  const [newCategoryOpen, setNewCategoryOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [creatingCategory, setCreatingCategory] = useState(false);

  const lifeAreas = useAsyncQuery({
    queryKey: ['life-areas', 'expense-selector'],
    queryFn: (signal) => fetchLifeAreas(signal),
  });
  const goalOptions = useAsyncQuery({
    queryKey: ['goals', 'expense-options', moreOpen ? 'open' : 'closed'],
    queryFn: (signal) =>
      moreOpen ? fetchGoalOptions(signal) : Promise.resolve(EMPTY_GOAL_OPTIONS),
  });
  const options =
    goalOptions.state.status === 'success' ? goalOptions.state.data : EMPTY_GOAL_OPTIONS;

  const currentCategory = categories.find((item) => item.id === categoryId);
  const currentArchived = currentCategory?.isArchived === true;

  const submit = async (overrideVersion?: number) => {
    const parsed = parseHumanToMinor(amount);
    if (!parsed.ok) {
      setAmountError(`${parsed.message}。例如 36.50。`);
      return;
    }
    if (categoryId === '') {
      setCategoryError('请选择一个分类');
      return;
    }
    setAmountError(undefined);
    setCategoryError(undefined);
    setFormError(null);
    setSaving(true);

    const body: ExpenseWriteInput = {
      amountMinor: parsed.minor,
      currencyCode: currency,
      categoryId,
      occurredOn,
      lifeAreaId: lifeAreaId === '' ? null : lifeAreaId,
      goalId: goalId === '' ? null : goalId,
      actionId: actionId === '' ? null : actionId,
      paymentMethod: paymentMethod === '' ? null : paymentMethod,
      note: note === '' ? null : note,
    };

    try {
      if (expense === null) {
        await createExpense(body);
      } else {
        await updateExpense(expense.id, { ...body, version: overrideVersion ?? expense.version });
      }
      onSaved();
    } catch (error) {
      // 409 是乐观并发冲突：复用 §4.9.2 的既有 ConflictDialog，不另造开销专用 UI。
      // 但浮层要**两版并列**才有意义——服务端 409 响应体不带服务端行（`ConflictError`
      // 只给 code / message / requestId），所以这里先真去取一次；取不到就退回就地文案
      // （与设置页先例同一口径），绝不拿本地陈旧行冒充服务端版本。
      if (error instanceof ApiRequestError && error.status === 409 && expense !== null) {
        onStale();
        const server = await resolveServerExpense(expense.id);
        if (server === null) {
          setFormError('这笔开销已在别处被修改。请重新加载页面后再改。');
        } else {
          setConflict({ input: body, server });
        }
      } else {
        setFormError(error instanceof Error ? error.message : '保存失败，请稍后重试');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCreateCategory = async () => {
    const name = newCategoryName.trim();
    if (name === '') {
      return;
    }
    setCreatingCategory(true);
    const created = await onCreateCategory(name);
    setCreatingCategory(false);
    if (created !== null) {
      setCategoryChoice(created.id);
      setNewCategoryName('');
      setNewCategoryOpen(false);
    }
  };

  const associationValue =
    actionId !== '' ? `action:${actionId}` : goalId !== '' ? `goal:${goalId}` : '';

  return (
    <Drawer
      open
      title={isEdit ? '编辑开销' : '记一笔'}
      onClose={onClose}
      initialFocusSelector="[data-expense-amount]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            保存
          </Button>
        </>
      }
    >
      <div className={styles.fields}>
        <div className={styles.amountRow}>
          <div className={styles.amount}>
            <Input
              data-expense-amount
              label="金额（必填）"
              aria-required="true"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={amount}
              error={amountError}
              onChange={(event) => {
                if (isAmountTyping(event.target.value)) {
                  setAmount(event.target.value);
                }
              }}
            />
          </div>
          <ExpenseSelect
            label="币种"
            value={currency}
            onChange={setCurrency}
            groups={[
              {
                label: '',
                options: CURRENCY_OPTIONS.map((code) => ({ value: code, label: code })),
              },
            ]}
          />
        </div>

        <ExpenseSelect
          label="分类（必填）"
          searchable
          searchLabel="搜索分类"
          value={categoryId}
          error={categoryError}
          placeholder="请选择"
          groups={buildCategoryGroups(categories, recentCategoryIds, categoryId)}
          onChange={(next) => {
            setCategoryError(undefined);
            setCategoryChoice(next);
          }}
          footer={
            <>
              {currentArchived ? (
                <p className={styles.archivedNote}>
                  <Badge variant="neutral">已停用</Badge>
                  当前分类已停用，只能保持或换新。
                </p>
              ) : null}
              {newCategoryOpen ? (
                <div className={styles.inlineForm}>
                  <Input
                    label="新分类名称"
                    maxLength={60}
                    hint="名称最长 60 个字符。"
                    value={newCategoryName}
                    disabled={creatingCategory}
                    onChange={(event) => {
                      setNewCategoryName(event.target.value);
                    }}
                  />
                  <div className={styles.inlineActions}>
                    <Button
                      variant="primary"
                      loading={creatingCategory}
                      disabled={newCategoryName.trim() === ''}
                      onClick={() => void handleCreateCategory()}
                    >
                      创建并选中
                    </Button>
                    <Button
                      onClick={() => {
                        setNewCategoryOpen(false);
                        setNewCategoryName('');
                      }}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setNewCategoryOpen(true);
                  }}
                >
                  ＋ 新建分类
                </Button>
              )}
            </>
          }
        />

        <Input
          label="日期（必填）"
          aria-required="true"
          type="date"
          max={localCalendarDate()}
          value={occurredOn}
          onChange={(event) => {
            setOccurredOn(event.target.value);
          }}
        />

        <div>
          <Button
            variant="ghost"
            aria-expanded={moreOpen}
            onClick={() => {
              setMoreOpen((current) => !current);
            }}
          >
            {moreOpen ? '收起更多信息' : '更多信息'}
          </Button>
        </div>

        {moreOpen ? (
          <div className={styles.moreFields}>
            <ExpenseSelect
              label="支付方式"
              searchable
              searchLabel="搜索支付方式"
              placeholder="不指定"
              value={paymentMethod}
              groups={[
                {
                  label: '',
                  options: PAYMENT_METHOD_OPTIONS.map((item) => ({ value: item, label: item })),
                },
              ]}
              onChange={setPaymentMethod}
            />

            <Textarea
              label="备注"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />

            <ExpenseSelect
              label="生活领域"
              searchable
              searchLabel="搜索生活领域"
              placeholder="不指定"
              value={lifeAreaId}
              groups={[
                {
                  label: '',
                  options:
                    lifeAreas.state.status === 'success'
                      ? lifeAreas.state.data.map((area) => ({ value: area.id, label: area.name }))
                      : [],
                },
              ]}
              onChange={setLifeAreaId}
            />

            <ExpenseSelect
              label="关联目标或行动"
              searchable
              searchLabel="搜索目标或行动"
              placeholder="不关联"
              value={associationValue}
              groups={buildAssociationGroups(options)}
              onChange={(next) => {
                const parsed = parseAssociationValue(next, options);
                setGoalId(parsed.goalId);
                setActionId(parsed.actionId);
              }}
            />
          </div>
        ) : null}

        {formError === null ? null : (
          <p className={styles.error} role="alert">
            {formError}
          </p>
        )}
      </div>

      {conflict === null || expense === null ? null : (
        <ConflictDialog
          open
          entityName={expense.note ?? '这笔开销'}
          local={toConflictView(conflict.input, categories)}
          server={toConflictViewOfExpense(conflict.server, categories)}
          pending={saving}
          onLater={() => {
            setConflict(null);
          }}
          onKeepServer={() => {
            // 「保留服务器版本」＝放弃本次编辑：关掉抽屉，列表已由 `onStale` 重新取过，
            // 上面显示的就是服务端那版。
            setConflict(null);
            onClose();
          }}
          onKeepLocal={() => {
            // `version` 已在开浮层时取到，直接拿它重发——不必在用户点击时再等一次网络。
            const version = conflict.server.version;
            setConflict(null);
            void submit(version);
          }}
        />
      )}
    </Drawer>
  );
}

/** 新建时的预选分类：最近使用优先，否则默认分类组首项（FR-051 列示顺序）。 */
function pickDefaultCategory(
  categories: readonly ExpenseCategoryItem[],
  recentCategoryIds: readonly string[],
): string | null {
  const active = categories.filter((item) => !item.isArchived);
  for (const id of recentCategoryIds) {
    if (active.some((item) => item.id === id)) {
      return id;
    }
  }
  const defaults = active
    .filter((item) => item.isDefault)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return defaults[0]?.id ?? active[0]?.id ?? null;
}

/** 分类选择器分组：最近使用（≤3）→ 默认分类（9）→ 自定义（创建时间倒序近似）。 */
function buildCategoryGroups(
  categories: readonly ExpenseCategoryItem[],
  recentCategoryIds: readonly string[],
  currentCategoryId: string,
): readonly SelectGroup[] {
  const active = categories.filter((item) => !item.isArchived);
  const recent = recentCategoryIds
    .map((id) => active.find((item) => item.id === id))
    .filter((item): item is ExpenseCategoryItem => item !== undefined)
    .slice(0, 3);
  const defaults = active
    .filter((item) => item.isDefault)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  // DTO 无 createdAt；新建 `sortOrder` 取末位，故倒序近似「创建时间倒序」。
  const customs = active
    .filter((item) => !item.isDefault)
    .sort((a, b) => b.sortOrder - a.sortOrder);

  const groups: SelectGroup[] = [];
  const current = categories.find((item) => item.id === currentCategoryId);
  if (current?.isArchived === true) {
    groups.push({
      label: '当前',
      options: [{ value: current.id, label: `${current.name}（已停用）` }],
    });
  }
  if (recent.length > 0) {
    groups.push({
      label: '最近使用',
      options: recent.map((item) => ({ value: item.id, label: item.name })),
    });
  }
  groups.push({
    label: '默认分类',
    options: defaults.map((item) => ({ value: item.id, label: item.name })),
  });
  if (customs.length > 0) {
    groups.push({
      label: '自定义',
      options: customs.map((item) => ({ value: item.id, label: item.name })),
    });
  }
  return groups;
}

/** 「关联目标或行动」分组：目标 / 行动两组（行动显示为「目标名 › 行动名」）。 */
function buildAssociationGroups(options: GoalOptions): readonly SelectGroup[] {
  const groups: SelectGroup[] = [];
  if (options.goals.length > 0) {
    groups.push({
      label: '目标',
      options: options.goals.map((goal) => ({ value: `goal:${goal.id}`, label: goal.name })),
    });
  }
  if (options.actions.length > 0) {
    groups.push({
      label: '行动',
      options: options.actions.map((action) => ({
        value: `action:${action.id}`,
        label: `${action.goalName} › ${action.name}`,
      })),
    });
  }
  return groups;
}

/** 选择器的值 → `{ goalId, actionId }`；选中行动时同时带上其父目标（§9 关联口径）。 */
function parseAssociationValue(
  value: string,
  options: GoalOptions,
): { readonly goalId: string; readonly actionId: string } {
  if (value.startsWith('action:')) {
    const actionId = value.slice('action:'.length);
    const parent = options.actions.find((action) => action.id === actionId);
    return { goalId: parent?.goalId ?? '', actionId };
  }
  if (value.startsWith('goal:')) {
    return { goalId: value.slice('goal:'.length), actionId: '' };
  }
  return { goalId: '', actionId: '' };
}

function categoryLabel(categories: readonly ExpenseCategoryItem[], id: string): string {
  return categories.find((item) => item.id === id)?.name ?? '未分类';
}

/** 尝试保存的值 → 冲突浮层的「此设备的版本」摘要。 */
function toConflictView(
  input: ExpenseWriteInput,
  categories: readonly ExpenseCategoryItem[],
): ConflictVersionView {
  return {
    changedAtLabel: null,
    fields: [
      { label: '金额', value: `${formatMinorToHuman(input.amountMinor)} ${input.currencyCode}` },
      { label: '分类', value: categoryLabel(categories, input.categoryId) },
      { label: '日期', value: input.occurredOn },
    ],
  };
}

/** 已知的服务端行 → 冲突浮层的「服务器上的版本」摘要。 */
function toConflictViewOfExpense(
  expense: ExpenseItem,
  categories: readonly ExpenseCategoryItem[],
): ConflictVersionView {
  return {
    changedAtLabel: null,
    fields: [
      {
        label: '金额',
        value: `${formatMinorToHuman(expense.amountMinor)} ${expense.currencyCode}`,
      },
      { label: '分类', value: categoryLabel(categories, expense.categoryId) },
      { label: '日期', value: expense.occurredOn },
    ],
  };
}
