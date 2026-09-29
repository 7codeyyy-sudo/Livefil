/**
 * 开销域的接口封装与金额换算（EXP-001~004，《接口文档》§9）。
 *
 * ## 它是什么
 *
 * 组件不拼 URL、不认识信封形状，所以开销的出入参集中在这里——路径只出现一处，
 * 返回类型直接标注成契约里的字段形状（与 `identity-api.ts` 同一纪律）。
 *
 * ## 为什么金额换算在这里、且全程字符串
 *
 * 契约要求 `amountMinor` 是**最小货币单位整数字符串**（`/^[1-9]\d{0,18}$/`）：
 * 它正是为了避开 JavaScript 大整数精度问题才用字符串。若在 UI 侧用
 * `parseFloat` / `Math.round(x * 100)` 换算，就把那份精度问题原样搬回客户端，
 * 而且是在最靠近用户输入的地方。所以换算只用字符串与整数运算，不引入第二套口径。
 */
import type { GoalItem } from './queries';
import { fetchJson, sendJson } from './api-client';
import type { ApiEnvelope } from './api-client';

/** `GET /expenses` 返回项（《接口文档》§9 响应项字段）。 */
export interface ExpenseItem {
  readonly id: string;
  readonly categoryId: string;
  readonly lifeAreaId: string | null;
  readonly goalId: string | null;
  readonly actionId: string | null;
  /** 最小货币单位整数**字符串**。 */
  readonly amountMinor: string;
  readonly currencyCode: string;
  readonly occurredOn: string;
  readonly paymentMethod: string | null;
  readonly note: string | null;
  readonly source: string;
  readonly deletedAt: string | null;
  readonly version: number;
}

/** `GET /expense-categories` 返回项（《接口文档》§9）。 */
export interface ExpenseCategoryItem {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly isDefault: boolean;
  readonly isArchived: boolean;
  readonly version: number;
}

/** `GET /expenses` 的筛选维度（与 `listExpensesQuerySchema` 一一对应）。 */
export interface ExpenseListFilter {
  readonly from: string;
  readonly to: string;
  readonly categoryId: string;
  readonly lifeAreaId: string;
  readonly goalId: string;
}

/** 空筛选（首页与「最近使用」缓存的判据都基于它）。 */
export const EMPTY_EXPENSE_FILTER: ExpenseListFilter = {
  from: '',
  to: '',
  categoryId: '',
  lifeAreaId: '',
  goalId: '',
};

/** 任一项生效即视为「有筛选」。 */
export function hasActiveFilter(filter: ExpenseListFilter): boolean {
  return (
    filter.from !== '' ||
    filter.to !== '' ||
    filter.categoryId !== '' ||
    filter.lifeAreaId !== '' ||
    filter.goalId !== ''
  );
}

/**
 * 把筛选拼成 `URLSearchParams`（空值不写进查询串）。
 *
 * `limit` 固定 20：接口默认值即 20（§9），显式写出来是为了让「最近使用」缓存
 * 取的是与列表首页一致的页大小。
 */
export function buildExpenseQuery(filter: ExpenseListFilter, cursor: string | null): string {
  const params = new URLSearchParams({ limit: '20' });
  if (filter.from !== '') params.set('from', filter.from);
  if (filter.to !== '') params.set('to', filter.to);
  if (filter.categoryId !== '') params.set('categoryId', filter.categoryId);
  if (filter.lifeAreaId !== '') params.set('lifeAreaId', filter.lifeAreaId);
  if (filter.goalId !== '') params.set('goalId', filter.goalId);
  if (cursor !== null) params.set('cursor', cursor);
  return params.toString();
}

/* ------------------------------------------------------------------ */
/* 金额换算（全程字符串 / 整数，禁止 float）                              */
/* ------------------------------------------------------------------ */

const AMOUNT_INPUT_PATTERN = /^(\d{1,19})(?:\.(\d{1,2}))?$/;
/** 输入过程中的合法前缀：允许「36」「36.」「36.5」，小数不超过两位。 */
const AMOUNT_TYPING_PATTERN = /^\d*(?:\.\d{0,2})?$/;
/** 金额上限 19 位＝`bigint` 十进制容量（与契约正则一致）。 */
const AMOUNT_MINOR_MAX_LENGTH = 19;

/** 键入拦截：只接受数字与至多两位小数（其余字符不接受）。 */
export function isAmountTyping(raw: string): boolean {
  return raw === '' || AMOUNT_TYPING_PATTERN.test(raw);
}

/**
 * 人类金额（`36.50`）→ 最小货币单位字符串（`"3650"`）。
 *
 * 只在提交前调用，逐位补零后拼接，不做任何浮点运算。
 */
export function parseHumanToMinor(
  raw: string,
):
  { readonly ok: true; readonly minor: string } | { readonly ok: false; readonly message: string } {
  const value = raw.trim();
  if (value === '') {
    return { ok: false, message: '请填写金额' };
  }
  const matched = AMOUNT_INPUT_PATTERN.exec(value);
  if (matched === null) {
    return { ok: false, message: '金额只能是数字，最多两位小数（如 36.50）' };
  }
  const integerPart = (matched[1] ?? '0').replace(/^0+(?=\d)/, '');
  const fractionPart = (matched[2] ?? '').padEnd(2, '0');
  const minor = `${integerPart}${fractionPart}`.replace(/^0+/, '');
  if (minor === '') {
    return { ok: false, message: '金额必须大于 0' };
  }
  if (minor.length > AMOUNT_MINOR_MAX_LENGTH) {
    return { ok: false, message: '金额超出可记录范围' };
  }
  return { ok: true, minor };
}

/** 最小货币单位字符串（`"3650"`）→ 人类金额（`36.50`）；展示用，同样纯字符串运算。 */
export function formatMinorToHuman(minor: string): string {
  const digits = /^\d+$/.test(minor) ? minor : '0';
  const padded = digits.padStart(3, '0');
  const integerPart = padded.slice(0, -2);
  const fractionPart = padded.slice(-2);
  return `${integerPart}.${fractionPart}`;
}

/* ------------------------------------------------------------------ */
/* 开销写操作                                                            */
/* ------------------------------------------------------------------ */

/** `POST/PATCH /expenses` 的可写字段（可空项一律显式给 `null`，不靠缺省）。 */
export interface ExpenseWriteInput {
  readonly amountMinor: string;
  readonly currencyCode: string;
  readonly categoryId: string;
  readonly occurredOn: string;
  readonly lifeAreaId: string | null;
  readonly goalId: string | null;
  readonly actionId: string | null;
  readonly paymentMethod: string | null;
  readonly note: string | null;
}

export function createExpense(body: ExpenseWriteInput): Promise<ApiEnvelope<ExpenseItem>> {
  return sendJson<ExpenseItem>('POST', '/api/v1/expenses', body);
}

export function updateExpense(
  expenseId: string,
  body: ExpenseWriteInput & { readonly version: number },
): Promise<ApiEnvelope<ExpenseItem>> {
  return sendJson<ExpenseItem>('PATCH', `/api/v1/expenses/${expenseId}`, body);
}

/**
 * 按 id 取服务端当前的这一笔（PATCH 撞 409 时用来渲染「服务器上的版本」）。
 *
 * ## 为什么现在能直取
 *
 * 契约原先**没有**实体读取路径（§9 的实体路径只有 PATCH / DELETE），而 409 的响应体
 * 按 §4.9.2 只给 code / message / requestId，不带服务端行。当时的替代做法是从
 * **无筛选列表首页**（`limit=100`）里反查——早于最近 100 笔的记录就不在首页里，
 * 只能退化为「重新加载页面」的降级文案（缺口见 RD-20260928-005 §七①）。
 *
 * 第 8 项随批勘误补上 `GET /expenses/{expenseId}`（接口文档 v0.5 §9）后，这里按 id
 * 直取即可：**再也不存在"取不到"的正常情形**——那一行必然存在（409 是版本不匹配，
 * 不是行不存在）。因此 `null` 只剩一种含义：**这次读取本身失败了**（超时、断网、
 * 服务端 5xx）。调用方据此提示可重试，而不是像过去那样说"请重新加载页面"。
 */
export async function fetchExpenseById(
  expenseId: string,
  signal: AbortSignal,
): Promise<ExpenseItem | null> {
  try {
    const envelope = await fetchJson<ExpenseItem>(`/api/v1/expenses/${expenseId}`, signal);
    return envelope.data;
  } catch {
    return null;
  }
}

/** 软删除：响应体即「可撤销信息」（含 `deletedAt` 与撤销要带的 `version`）。 */
export function deleteExpense(expenseId: string): Promise<ApiEnvelope<ExpenseItem>> {
  return sendJson<ExpenseItem>('DELETE', `/api/v1/expenses/${expenseId}`);
}

export function restoreExpense(
  expenseId: string,
  version: number,
): Promise<ApiEnvelope<ExpenseItem>> {
  return sendJson<ExpenseItem>('POST', `/api/v1/expenses/${expenseId}/restore`, { version });
}

/* ------------------------------------------------------------------ */
/* 分类                                                                  */
/* ------------------------------------------------------------------ */

export async function fetchExpenseCategories(
  signal: AbortSignal,
  includeArchived: boolean,
): Promise<readonly ExpenseCategoryItem[]> {
  const query = includeArchived ? '?includeArchived=true' : '';
  const envelope = await fetchJson<{ readonly items: readonly ExpenseCategoryItem[] }>(
    `/api/v1/expense-categories${query}`,
    signal,
  );
  return envelope.data.items;
}

export function createExpenseCategory(name: string): Promise<ApiEnvelope<ExpenseCategoryItem>> {
  return sendJson<ExpenseCategoryItem>('POST', '/api/v1/expense-categories', { name });
}

export function updateExpenseCategory(
  categoryId: string,
  patch: { readonly name?: string; readonly isArchived?: boolean },
): Promise<ApiEnvelope<ExpenseCategoryItem>> {
  return sendJson<ExpenseCategoryItem>('PATCH', `/api/v1/expense-categories/${categoryId}`, patch);
}

/* ------------------------------------------------------------------ */
/* 关联目标或行动（选择器数据）                                           */
/* ------------------------------------------------------------------ */

/** 选择器里的一项行动（显示为「目标名 › 行动名」消歧）。 */
export interface ActionOption {
  readonly id: string;
  readonly name: string;
  readonly goalId: string;
  readonly goalName: string;
}

export interface GoalOptions {
  readonly goals: readonly GoalItem[];
  readonly actions: readonly ActionOption[];
}

/**
 * 拉取「活跃目标 + 其下行动」。
 *
 * 接口没有「行动集合」端点，行动只在目标详情里随聚合返回，所以这里先取活跃目标，
 * 再逐个取详情（N+1）。这是本批已知取舍：目标量在个人应用里有限，换取的是
 * 「目标 / 行动」两组选择器一次拿全，不必让用户先选目标再看行动。
 */
export async function fetchGoalOptions(signal: AbortSignal): Promise<GoalOptions> {
  const envelope = await fetchJson<{ readonly items: readonly GoalItem[] }>(
    '/api/v1/goals?status=active&limit=50',
    signal,
  );
  const goals = envelope.data.items;

  const details = await Promise.all(
    goals.map((goal) =>
      fetchJson<{ readonly goal: GoalItem; readonly actions: readonly ActionOptionRaw[] }>(
        `/api/v1/goals/${goal.id}`,
        signal,
      ).then((detail) => ({ goal, actions: detail.data.actions })),
    ),
  );

  const actions: ActionOption[] = [];
  for (const detail of details) {
    for (const action of detail.actions) {
      actions.push({
        id: action.id,
        name: action.name,
        goalId: detail.goal.id,
        goalName: detail.goal.name,
      });
    }
  }
  return { goals, actions };
}

interface ActionOptionRaw {
  readonly id: string;
  readonly name: string;
}
