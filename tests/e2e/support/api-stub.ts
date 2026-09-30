/**
 * 浏览器用例的 API 桩（UI-004）。
 *
 * ## 为什么需要它
 *
 * 从 UI-004 起，五个状态页会按《UI 页面规范》v0.14 §4.7 用**真实端点**取数，
 * 而本批**不建业务端点**。于是不拦截的话，每个访问这些页面的用例都会产生一次
 * 404——那是「数据源还没接上」的**预期表现**，但浏览器会把它记成一条
 * resource error。
 *
 * 这会污染那些「断言页面没有控制台错误」的用例：它们要查的是**样式或脚本**
 * 的问题，而不是一个已知且预期的 404。把这些请求接成正常的空结果，断言才
 * 指向真正的问题。
 *
 * ## 为什么不是每个 spec 各写一遍
 *
 * 三处重复的 `route.fulfill` 里藏着同一个约定（信封形状、路径 glob）；写三遍
 * 就有三个可能漂移的版本。放在这里，改信封形状只需改一处。
 *
 * 文件名不含 `.spec.ts`，所以 Playwright 不会把它当作用例文件收集。
 */
import type { Page, Route } from '@playwright/test';

/** 《接口文档》§1.3 的分页信封，空结果。 */
const EMPTY_TASKS_ENVELOPE = { data: [], meta: { hasMore: false } };

/**
 * 把任务查询接成「成功但为空」。
 *
 * 必须在 `page.goto` **之前**调用：Playwright 的 `page.route` 只对注册之后
 * 发出的请求生效，而页面挂载后立刻就会取数。
 */
export async function stubTaskQueryAsEmpty(page: Page): Promise<void> {
  await page.route('**/api/v1/tasks*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_TASKS_ENVELOPE),
    }),
  );
  /**
   * 今日页自 UI-007 起走 `GET /today` 聚合——数据源迁移后这里必须一并 stub，
   * 否则真实请求在本地 500 / 在 CI 因无 DATABASE_URL 必红（审查重要 7，
   * 按 tokens 用例注释的原意：stub 数据源而不是给 CI 加数据库）。
   */
  await page.route('**/api/v1/today*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          date: '2026-01-01',
          currentAction: null,
          blocks: [],
          fixedCommitments: [],
          unscheduledTasks: [],
          routines: [],
          habits: [],
          load: {
            fixedMinutes: 0,
            plannedMinutes: 0,
            completedMinutes: 0,
            availableMinutes: 960,
            overloaded: false,
          },
          recovery: { manual: false, since: null, autoTriggered: false, suggestions: [] },
        },
        meta: { requestId: 'stub' },
      }),
    }),
  );
}

/** §16 `GET /notifications/pending` 的空结果（载荷是数组本身，不是 `items` 包一层）。 */
const EMPTY_PENDING_ENVELOPE = { data: [], meta: { requestId: 'stub' } };

/** 空例程列表（面板标题补名用，形状同 `GET /routines` 的 `{ items }`）。 */
const EMPTY_ROUTINES_ENVELOPE = { data: { items: [] }, meta: { requestId: 'stub' } };

/**
 * 把通知域的取数接成「成功但为空」。
 *
 * 应用外壳（`app/(app)/layout.tsx`）自 NOTIFY-002 起在**每个应用内页面**都会取
 * 一次待处理提醒——顶栏铃铛的未读数是列表条数（《UI 页面规范》v0.23 §5 B），
 * 随后还会取一次例程清单给面板标题补名（§16 的 pending 载荷不带对象名）。
 * 不接住这两条，凡是「断言页面没有控制台错误」的用例都会多出一条 500 的
 * resource error：本地没有数据库、CI 的 browser-e2e 作业也没有 DATABASE_URL。
 *
 * 与 `stubTaskQueryAsEmpty` 里那条 `/today` 同一个理由：**stub 数据源，而不是
 * 给 CI 加数据库**。必须在 `page.goto` **之前**调用。
 */
export async function stubNotificationsAsEmpty(page: Page): Promise<void> {
  await page.route('**/api/v1/notifications/pending*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_PENDING_ENVELOPE),
    }),
  );
  await page.route('**/api/v1/routines*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_ROUTINES_ENVELOPE),
    }),
  );
}

/** 空分类列表。 */
const EMPTY_CATEGORIES_ENVELOPE = { data: { items: [] }, meta: { nextCursor: null } };

/**
 * 把分类查询接成「成功但为空」。
 *
 * 必须在 `page.goto` **之前**调用。
 */
export async function stubExpenseCategoriesData(page: Page): Promise<void> {
  await page.route('**/api/v1/expense-categories*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_CATEGORIES_ENVELOPE),
    }),
  );
}

/** 空支出列表。 */
const EMPTY_EXPENSES_ENVELOPE = { data: { items: [] }, meta: { nextCursor: null, hasMore: false } };

/**
 * 把支出查询接成「成功但为空」。
 *
 * 必须在 `page.goto` **之前**调用。
 */
export async function stubExpenseData(page: Page): Promise<void> {
  await page.route('**/api/v1/expenses*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_EXPENSES_ENVELOPE),
    }),
  );
}

/** 空日复盘。 */
const EMPTY_DAILY_REVIEW = { data: null, meta: { requestId: 'stub' } };

/** 空周复盘。 */
const EMPTY_WEEKLY_REVIEW = { data: null, meta: { requestId: 'stub' } };

/** 周复盘四态计数（B2 第 1/2 项的固定四枚 Badge）。 */
export interface StubWeeklyTaskStatusCounts {
  readonly completed: number;
  readonly partial: number;
  readonly deferred: number;
  readonly skipped: number;
}

/** 构造周复盘 `data`（其余字段给零值，只让用例控制它要断言的那一项）。 */
export function weeklyReviewData(
  counts: Partial<StubWeeklyTaskStatusCounts> = {},
): Readonly<Record<string, unknown>> {
  return {
    weekStart: '2026-01-05',
    planActual: { plannedMinutes: 0, actualMinutes: 0 },
    taskStatusCounts: {
      completed: 0,
      partial: 0,
      deferred: 0,
      skipped: 0,
      ...counts,
    },
    repeatedDeferrals: [],
    goalActions: [],
    expenseSummaries: [],
    adjustments: [],
    snapshotSchemaVersion: null,
  };
}

/**
 * 把日复盘接成「成功但为空」（`data: null`＝这天还没填写），并可**按需**给周复盘
 * 一份有数据的载荷。
 *
 * 《接口文档》§10 的 `data: null` 表示「还没填写」而非错误：日复盘据此落可填写态，
 * 周复盘据此则整段不渲染（`WeeklyReviewSection` 在 `data === null` 时返回空）。
 * 因此要验证 B2/B4 的页面元素（四枚 Badge、「查看下周计划」链接）时，必须给周复盘
 * 一份**非空**载荷——由调用方按需传入，不传时维持既有行为（两段都接空）。
 *
 * 必须在 `page.goto` **之前**调用。
 */
export async function stubReviewData(
  page: Page,
  options: { readonly weekly?: Readonly<Record<string, unknown>> | undefined } = {},
): Promise<void> {
  await page.route('**/api/v1/reviews/daily/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_DAILY_REVIEW),
    }),
  );
  await page.route('**/api/v1/reviews/weekly/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        options.weekly === undefined
          ? EMPTY_WEEKLY_REVIEW
          : { data: options.weekly, meta: { requestId: 'stub' } },
      ),
    }),
  );
}

/** `GET /schedule-blocks`、`GET /fixed-commitments` 的空 `{ items }` 载荷。 */
const EMPTY_ITEMS_ENVELOPE = { data: { items: [] }, meta: { requestId: 'stub' } };

/**
 * 把周视图（`/week`）的两条数据源接成「成功但为空」。
 *
 * `/week` 的七日网格只在两条取数都成功后渲染（`WeekPanel` 的 `weekData === null`
 * 分支）；不接住它们的话，无数据库环境下两请求 500、网格整块不渲染。
 * 必须在 `page.goto` **之前**调用。
 */
export async function stubWeekScheduleData(page: Page): Promise<void> {
  await page.route('**/api/v1/schedule-blocks*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_ITEMS_ENVELOPE),
    }),
  );
  await page.route('**/api/v1/fixed-commitments*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_ITEMS_ENVELOPE),
    }),
  );
}

/** 分类桩数据（与 `ExpenseCategoryItem` 同形）。 */
export interface StubExpenseCategory {
  id: string;
  name: string;
  sortOrder: number;
  isDefault: boolean;
  isArchived: boolean;
  version: number;
}

/** 开销域桩的可变状态。 */
export interface ExpenseStub {
  readonly categories: StubExpenseCategory[];
}

/** 预置分类（两个默认 + 一个自定义，供重命名/停用用例操作）。 */
const INITIAL_EXPENSE_CATEGORIES: readonly Omit<StubExpenseCategory, 'id'>[] = [
  { name: '餐饮', sortOrder: 0, isDefault: true, isArchived: false, version: 1 },
  { name: '交通', sortOrder: 1, isDefault: true, isArchived: false, version: 1 },
  { name: '差旅', sortOrder: 2, isDefault: false, isArchived: false, version: 1 },
];

/**
 * 状态化的开销域桩（`/expense-categories` 与 `/expenses`）。
 *
 * ## 为什么必须状态化
 *
 * A6 的三条链路（新建 / 重命名 / 停用+恢复）都是**写后读**：写请求的响应决定
 * 界面下一步显示什么，而列表又要在写后立刻反映出来。一个只会回固定 JSON 的桩
 * 会让所有写操作"看起来成功了"，却无法验证「列表随即更新 / 分类从活跃列表消失」
 * 这些真正要断言的行为——这与会返回空列表的 `stubExpenseCategoriesData` 是两个
 * 用途（后者只服务「页面不因 404 记一条 resource error」的场景）。
 *
 * 与 `settings-api-stub.ts` 同一纪律：桩内部维护内存数据，`version` 自增、
 * 停用＝置 `is_archived`（A6 冻结映射）。
 *
 * 必须在 `page.goto` **之前**调用。
 */
export async function installExpenseStub(
  page: Page,
  options: { readonly categories?: readonly StubExpenseCategory[] | undefined } = {},
): Promise<ExpenseStub> {
  const state: ExpenseStub = {
    categories:
      options.categories === undefined
        ? INITIAL_EXPENSE_CATEGORIES.map((item, index) => ({
            ...item,
            id: `cat-${String(index + 1)}`,
          }))
        : options.categories.map((item) => ({ ...item })),
  };
  let sequence = state.categories.length;

  const json = (route: Route, data: unknown, status = 200): Promise<void> =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ data, meta: { requestId: 'stub' } }),
    });

  const notFound = (route: Route): Promise<void> =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'NOT_FOUND', message: '分类不存在', requestId: 'stub' },
      }),
    });

  const readBody = (route: Route): Record<string, unknown> => {
    const raw = route.request().postData();
    return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
  };

  const bySortOrder = (a: StubExpenseCategory, b: StubExpenseCategory): number =>
    a.sortOrder - b.sortOrder;

  // `**`（而非 `*`）才能同时覆盖集合路径（含查询串）与子路径
  // `/expense-categories/{id}`——`*` 不匹配 `/`，PATCH 会漏出桩外。
  await page.route('**/api/v1/expense-categories**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    if (path === '/api/v1/expense-categories') {
      if (method === 'GET') {
        return json(route, { items: [...state.categories].sort(bySortOrder) });
      }
      if (method === 'POST') {
        const body = readBody(route);
        const name = typeof body.name === 'string' ? body.name : '';
        sequence += 1;
        const created: StubExpenseCategory = {
          id: `cat-${String(sequence)}`,
          name,
          sortOrder: state.categories.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1,
          isDefault: false,
          isArchived: false,
          version: 1,
        };
        state.categories.push(created);
        return json(route, created, 201);
      }
    }

    const itemMatch = /^\/api\/v1\/expense-categories\/([^/]+)$/.exec(path);
    if (itemMatch !== null && method === 'PATCH') {
      const id = itemMatch[1] ?? '';
      const item = state.categories.find((category) => category.id === id);
      if (item === undefined) {
        return notFound(route);
      }
      const body = readBody(route);
      if (typeof body.name === 'string') {
        item.name = body.name;
      }
      if (typeof body.isArchived === 'boolean') {
        item.isArchived = body.isArchived;
      }
      item.version += 1;
      return json(route, item);
    }

    return notFound(route);
  });

  // 列表查询接成空页（`readCursorPage` 从 meta 读游标，缺省即「没有下一页」）。
  await page.route('**/api/v1/expenses*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_ITEMS_ENVELOPE),
    }),
  );

  return state;
}

/**
 * 页面上的阻塞式错误态（`ErrorState`）。
 *
 * **必须排除 Next 的 RouteAnnouncer**：它渲染一个 `role="alert"` 的空 div
 * （`#__next-route-announcer__`），与 `ErrorState` 的 `role="alert"` 撞在一起，
 * 会让 `getByRole('alert')` 直接变成 strict-mode 违规——而那个元素与我们要
 * 断言的东西毫无关系。
 */
export function errorState(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}
