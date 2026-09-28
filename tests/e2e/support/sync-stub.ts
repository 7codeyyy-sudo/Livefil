/**
 * 同步相关浏览器用例的 API 桩（SYNC-002 / SYNC-003 / SYNC-004）。
 *
 * ## 为什么必须 stub 而不是打真接口
 *
 * CI 的 `browser-e2e` job（`.github/workflows/ci.yml`）**不带数据库**：没有
 * `services:`、也没有注入 `DATABASE_URL`。凡是会落库的真实请求在 CI 里必然非 2xx。
 * 本目录既有约定（见 `api-stub.ts` 与 `page-state.spec.ts`）是：用例只验**客户端**
 * 行为，服务端用 `page.route` 假服务。
 *
 * ## 为什么集中在这里
 *
 * 「收件箱空数据」「push 逐条结果」「pull 空页」三组形状会在 `sync-status` 与
 * `sync-lan` 两个 spec 里重复；写两遍就有两个可能漂移的版本。改契约只改一处。
 *
 * ## 传输层失败要用 `route.abort`，不是返回 4xx/5xx
 *
 * `api-client.sendJson` **只在本请求根本没到达服务端**（网络错误 / 超时）时才把
 * 这条编辑交给同步层入队（`enqueueFailedWrite`）。若 stub 成 4xx/5xx，服务端已给出
 * 结论，界面走错误态而**不**入队——那不是「离线续用」的路径。
 *
 * 文件名不含 `.spec.ts`，Playwright 不会把它当作用例文件收集。
 */
import type { Page, Route } from '@playwright/test';

/** 空今日聚合（与 `page-state.spec.ts` / `api-stub.ts` 同一份空形态）。 */
const EMPTY_TODAY = {
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
};

/** 按《接口文档》§1.2/§1.3 的成功信封应答。 */
export async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * 把收件箱列表与今日聚合接成「成功但为空」。
 *
 * 必须在 `page.goto` **之前**调用：`page.route` 只对注册之后发出的请求生效，
 * 而页面挂载后立刻就会取数。
 *
 * 注意 glob：`…/api/v1/tasks?*` 带 `?`，因此**不**匹配 `POST /api/v1/tasks`
 * （创建请求没有查询串）——创建请求由 `failTaskCreate` 单独处理。
 */
export async function stubInboxData(page: Page): Promise<void> {
  await page.route('**/api/v1/today*', (route) =>
    fulfillJson(route, { data: EMPTY_TODAY, meta: { requestId: 'e2e' } }),
  );
  await page.route('**/api/v1/tasks?*', (route) =>
    fulfillJson(route, { data: { items: [] }, meta: { nextCursor: null, hasMore: false } }),
  );
}

/**
 * 让「快速添加」的 `POST /api/v1/tasks` 在**传输层**失败 → 触发本地入队。
 *
 * 这是造出「待同步 / 同步中 / 失败 / 被拒绝 / 冲突」各态的统一起点：入队后队列
 * 非空，横幅才有状态可算。**不**改 `navigator.onLine`（离线态另用
 * `context.setOffline`），因此横幅不会被离线态盖住。
 */
export async function failTaskCreate(page: Page): Promise<void> {
  await page.route('**/api/v1/tasks', (route) => {
    if (route.request().method() === 'POST') {
      return route.abort('failed');
    }
    // 其余方法（本批没有无查询串的 GET）原样放行。
    return route.continue();
  });
}

/** 收件箱首屏快速添加：填入标题并回车（`InboxPanel` 的 `#quick-add` 表单）。 */
export async function quickAddTask(page: Page, title: string): Promise<void> {
  const input = page.locator('#quick-add input');
  await input.fill(title);
  await input.press('Enter');
}

/** push 请求体（`sync-client.toPushOperation` 的形状，取用到的字段）。 */
export type PushRequestBody = {
  readonly operations: readonly {
    readonly operationId: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly operationType: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }[];
};

/** push 的逐条结果（《接口文档》§12.1.1 四态）。 */
export type PushResult =
  | {
      readonly operationId: string;
      readonly status: 'applied' | 'already_applied';
      readonly version: number;
    }
  | {
      readonly operationId: string;
      readonly status: 'conflict';
      readonly conflictId: string;
      readonly serverVersion: number;
      readonly serverPayload: Readonly<Record<string, unknown>>;
    }
  | {
      readonly operationId: string;
      readonly status: 'rejected';
      readonly reason: string;
    };

export type PushStubOptions = {
  /** 延迟应答毫秒数：用来把横幅钉在「同步中…」（状态 2）。 */
  readonly delayMs?: number;
  /** 请求到达时的观察钩子（例如统计 push 次数）。 */
  readonly onRequest?: (body: PushRequestBody) => void;
};

/** push → 按 `build` 逐条应答。 */
export async function stubPush(
  page: Page,
  build: (body: PushRequestBody) => readonly PushResult[],
  options: PushStubOptions = {},
): Promise<void> {
  await page.route('**/api/v1/sync/push', async (route) => {
    const body = readPushBody(route);
    options.onRequest?.(body);
    if (options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    await fulfillJson(route, {
      data: { results: build(body) },
      meta: { requestId: 'e2e' },
    });
  });
}

/** 常用结果：逐条 `applied`。 */
export function appliedAll(body: PushRequestBody): readonly PushResult[] {
  return body.operations.map((operation) => ({
    operationId: operation.operationId,
    status: 'applied',
    version: 1,
  }));
}

/** push → 传输层失败：这一批被标成「失败」并留在队列（横幅状态 4）。 */
export async function stubPushAbort(page: Page): Promise<void> {
  await page.route('**/api/v1/sync/push', (route) => route.abort('failed'));
}

/** pull → 空页（同步轮次里紧跟在 push 之后的增量拉取）。 */
export async function stubPullEmpty(page: Page): Promise<void> {
  await page.route('**/api/v1/sync/pull*', (route) =>
    fulfillJson(route, { data: { changes: [], nextCursor: null }, meta: { requestId: 'e2e' } }),
  );
}

/** 从 push 请求体里读操作列表；缺体或形状不符时按空处理（不抛错）。 */
export function readPushBody(route: Route): PushRequestBody {
  const parsed = route.request().postDataJSON() as unknown;
  if (typeof parsed === 'object' && parsed !== null && 'operations' in parsed) {
    const operations = (parsed as { readonly operations?: unknown }).operations;
    if (Array.isArray(operations)) {
      return { operations: operations as PushRequestBody['operations'] };
    }
  }
  return { operations: [] };
}
