/**
 * Phase 3 UI 端到端测试（UI-005/006）。
 *
 * 用 `page.route` 拦截 `/api/v1/tasks*` 与 `/api/v1/goals*`：页面行为
 * （快速添加、加载更多累积、多选工具条、双进度展示）不依赖真机数据库，
 * 与 CI 的 browser-e2e 一样跑在 mock 契约上。响应信封对齐《接口文档》§1.2/§1.3。
 */
import { expect, test } from '@playwright/test';

type Task = {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dueDate: string | null;
  readonly estimatedMinutes: number | null;
  readonly minimumVersion: string | null;
  readonly lifeAreaId: string | null;
  readonly goalId: string | null;
  readonly version: number;
};

function envelope(data: unknown, extraMeta: Record<string, unknown> = {}) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      data,
      meta: { requestId: 'e2e-request', serverTime: new Date().toISOString(), ...extraMeta },
    }),
  };
}

function task(id: string, title: string): Task {
  return {
    id,
    title,
    status: 'inbox',
    dueDate: null,
    estimatedMinutes: null,
    minimumVersion: null,
    lifeAreaId: null,
    goalId: null,
    version: 1,
  };
}

/** 挂上收件箱两页数据的 mock：第一页 2 条 + hasMore，第二页 1 条。 */
function mockInbox(page: import('@playwright/test').Page): void {
  let firstCall = true;
  void page.route('**/api/v1/tasks?*', (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor');
    if (cursor === null && firstCall) {
      firstCall = false;
      void route.fulfill(
        envelope(
          { items: [task('t-1', '整理书桌'), task('t-2', '回复邮件')] },
          { nextCursor: 'cursor-1', hasMore: true },
        ),
      );
      return;
    }
    void route.fulfill(
      envelope({ items: [task('t-3', '预约体检')] }, { nextCursor: null, hasMore: false }),
    );
  });
  void page.route('**/api/v1/life-areas', (route) =>
    route.fulfill(envelope({ items: [{ id: 'area-1', name: '健康' }] })),
  );
}

test.describe('收件箱（UI-005）', () => {
  test('列表渲染、加载更多累积、多选出现批量工具条', async ({ page }) => {
    mockInbox(page);
    await page.goto('/inbox');

    await expect(page.getByText('整理书桌')).toBeVisible();
    await expect(page.getByText('回复邮件')).toBeVisible();

    // 加载更多是**累积**：第二页追加，第一页仍在。
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByText('预约体检')).toBeVisible();
    await expect(page.getByText('整理书桌')).toBeVisible();

    // 多选 ≥1 时批量工具条出现（§4.8：列表正上方，不投射顶栏）。
    await page.getByLabel('选择任务：整理书桌').check();
    await expect(page.getByText('已选 1 项')).toBeVisible();
    await expect(page.getByRole('button', { name: '批量安排' })).toBeVisible();
    await expect(page.getByRole('button', { name: '批量归档' })).toBeVisible();
    await page.getByRole('button', { name: '取消选择' }).click();
    await expect(page.getByText('已选 1 项')).toBeHidden();
  });

  test('空收件箱给空态；快速添加后出现新任务', async ({ page }) => {
    let created = false;
    void page.route('**/api/v1/tasks*', (route) => {
      if (route.request().method() === 'POST') {
        created = true;
        void route.fulfill(envelope(task('t-new', '写周报')));
        return;
      }
      void route.fulfill(
        envelope(
          { items: created ? [task('t-new', '写周报')] : [] },
          { nextCursor: null, hasMore: false },
        ),
      );
    });
    await page.goto('/inbox');

    await expect(page.getByText('收件箱是空的')).toBeVisible();

    await page.getByLabel('快速添加任务').fill('写周报');
    // exact：避免与顶栏「＋ 快速添加」子串匹配。
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await expect(page.getByText('已加入收件箱')).toBeVisible();
    await expect(page.getByText('写周报')).toBeVisible();
  });
});

test.describe('目标（UI-006）', () => {
  const goal = {
    id: 'g-1',
    name: '三个月内能跑 5 公里',
    status: 'active',
    targetDate: null,
    resultMetric: { current: 2, target: 5, unit: '公里', note: null },
    version: 1,
  };

  test('列表展示双进度摘要，详情可直达', async ({ page }) => {
    void page.route('**/api/v1/goals?*', (route) =>
      route.fulfill(envelope({ items: [goal] }, { nextCursor: null, hasMore: false })),
    );
    await page.goto('/goals');

    await expect(page.getByText('三个月内能跑 5 公里')).toBeVisible();
    // 结果进度摘要（手动 resultMetric）。
    await expect(page.getByText(/结果进度：2 \/ 5/)).toBeVisible();

    await page.getByRole('link', { name: /三个月内能跑 5 公里/ }).click();
    await expect(page).toHaveURL(/\/goals\/g-1$/);
  });

  test('详情页：双进度分开、行动列表与行动进度', async ({ page }) => {
    void page.route('**/api/v1/goals/g-1', (route) =>
      route.fulfill(
        envelope({
          goal,
          actions: [
            {
              id: 'a-1',
              name: '每周跑两次',
              minimumVersion: null,
              targetFrequency: null,
              estimatedMinutes: 30,
              status: 'active',
              version: 1,
            },
          ],
          actionProgress: { total: 1, completed: 0, active: 1, paused: 0 },
          expenses: [],
        }),
      ),
    );
    await page.goto('/goals/g-1');

    await expect(page.getByText('结果进度由你手动维护')).toBeVisible();
    await expect(page.getByText(/共 1 项 · 完成 0/)).toBeVisible();
    await expect(page.getByText('每周跑两次')).toBeVisible();
    // 行动就地控制：完成 / 删除。
    await expect(page.getByRole('button', { name: '完成' })).toBeVisible();
    await expect(page.getByRole('button', { name: '删除' })).toBeVisible();
  });

  test('详情页「今日任务」：创建即 planned、dueDate 必为今天（L514）', async ({ page }) => {
    const taskBodies: Array<Record<string, unknown>> = [];
    void page.route('**/api/v1/goals/g-1', (route) =>
      route.fulfill(
        envelope({
          goal,
          actions: [],
          actionProgress: { total: 0, completed: 0, active: 0, paused: 0 },
          expenses: [],
        }),
      ),
    );
    void page.route('**/api/v1/tasks', (route) => {
      if (route.request().method() === 'POST') {
        // 请求体取证：断言的是**发给服务端的契约**，而不是页面上的文案。
        taskBodies.push(route.request().postDataJSON() as Record<string, unknown>);
        void route.fulfill(envelope(task('t-today', '今天跑 1 公里')));
        return;
      }
      void route.fulfill(envelope({ items: [] }, { nextCursor: null, hasMore: false }));
    });
    await page.goto('/goals/g-1');

    await page.getByLabel('新增今日任务').fill('今天跑 1 公里');
    await page.getByRole('button', { name: '添加今日任务', exact: true }).click();

    await expect(page.getByText('已加入今日任务')).toBeVisible();
    expect(taskBodies).toHaveLength(1);
    expect(taskBodies[0]?.['title']).toBe('今天跑 1 公里');
    expect(taskBodies[0]?.['goalId']).toBe('g-1');
    // 创建即已安排（不先落收件箱），且日期是本地日历日——否则不会出现在今日视图。
    expect(taskBodies[0]?.['status']).toBe('planned');
    expect(taskBodies[0]?.['dueDate']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
