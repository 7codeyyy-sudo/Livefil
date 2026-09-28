/**
 * 离线续用 e2e（测试点 9）与「禁写断网刷新」负向断言。
 *
 * 口径来源：
 * - RD-20260923-003 §6.2 真机验收实测
 * - RD-20260923-003 终审口径 2：Service Worker 不进本批；「断网续用」=
 *   「已打开页面」在断网后仍可操作，**排除**「刷新/重开页面离线可用」
 * - QA-001 §10.2 预审要求：点 9 必须有 e2e 且含「禁刷新」负向断言
 *
 * ## 2026-09-28 修复（原实现不可执行，三条用例在 CI 全红）
 *
 * 1. 原 `beforeEach` 调 `seedTask()` 打真实 `POST /api/v1/tasks`。CI 的
 *    `browser-e2e` job 不带数据库（无 `services:`、无 `DATABASE_URL`），该请求
 *    必然非 2xx，hook 失败使三条用例一并变红。改成本目录既有约定
 *    （`page.route` stub，见 `page-state.spec.ts`）：这一层验的是**离线续用**，
 *    种数据不是被测对象。
 * 2. 原 `goOffline()` 用 `page.route(() => route.abort('timedout'))` 模拟断网。
 *    但离线横幅由 `navigator.onLine` 驱动（`use-online-status.ts` 的
 *    `useSyncExternalStore` + `computeBannerState` 的 `if (!online)`），
 *    route 拦截**不改**该值，横幅永远不会出现。改用 `context.setOffline()`，
 *    与 `page-state.spec.ts` 既有的离线用例同一手法。
 * 3. 原「已预取路由可软导航」断言（断网后点侧栏链接切页）**实测不成立**：
 *    生产构建下点击未被访问过的路由会落到 Chromium 原生错误页
 *    （This page couldn't load），属口径 2 已排除的「重开页面」形态。
 *    该断言已移除，口径差异另行上报；本条改为验证口径内真正的「仍可操作」：
 *    断网后在收件箱录入，仍写入本地队列并立即出现在列表里
 *    （机制见 `app/(app)/_lib/queries.ts` 的本地待同步项合并）。
 */
import { expect, test, type Page } from '@playwright/test';

/** 空今日聚合（与 `page-state.spec.ts` 同一份空形态）。 */
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

/** 离线横幅：冻结文案 + `data-offline-banner`（UI-004 §4.7，本批逐字节沿用）。 */
const OFFLINE_BANNER = '[data-offline-banner="true"]';

/** 外壳页面区（`AppShell.tsx`）。 */
const APP_PAGE = '[data-app-page]';

const FROZEN_OFFLINE_TEXT = '当前处于离线状态，显示的内容可能不是最新';

/** 断网期间录入的任务标题，同时用作「立现」断言的定位文本。 */
const OFFLINE_TASK_TITLE = '断网时记下的任务';

/** 收件箱首屏快速添加输入框（`InboxPanel` 的 `#quick-add` 表单）。 */
const QUICK_ADD_INPUT = '#quick-add input';

/**
 * 拦掉会落库的取数：本用例验的是断网续用，不引入真实后端。
 *
 * 与 `page-state.spec.ts` 同款：CI 的浏览器 E2E 无数据库，凡是会落库的请求都
 * 必须 stub，否则用例的成败取决于环境而不是被测行为。
 */
async function stubListData(page: Page): Promise<void> {
  await page.route('**/api/v1/today*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: EMPTY_TODAY, meta: { requestId: 'e2e' } }),
    }),
  );
  await page.route('**/api/v1/tasks?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [] }, meta: { nextCursor: null, hasMore: false } }),
    }),
  );
}

/** 进入已加载完成的收件箱页。 */
async function gotoLoadedInbox(page: Page): Promise<void> {
  await stubListData(page);
  await page.goto('/inbox');
  await expect(page.getByText('收件箱是空的')).toBeVisible();
}

/** 进入已加载完成的今日页。 */
async function gotoLoadedToday(page: Page): Promise<void> {
  await stubListData(page);
  await page.goto('/today');
  await expect(page.getByText('时间线')).toBeVisible();
}

test.describe('离线续用 e2e（测试点 9）', () => {
  test('已打开页面断网后 DOM 未变、离线横幅出现、断网录入仍立现', async ({ context, page }) => {
    await gotoLoadedInbox(page);

    await context.setOffline(true);

    // DOM 未变：断网前已渲染的页面区与内容都还在，没有被错误页或空白替代。
    await expect(page.locator(APP_PAGE)).toBeVisible();
    await expect(page.getByText('收件箱是空的')).toBeVisible();

    // 离线横幅出现（§4.9.1 离线态沿用 §4.7 机制，文案冻结）。
    const banner = page.locator(OFFLINE_BANNER);
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(FROZEN_OFFLINE_TEXT);

    // 仍可操作：断网后录入 → 写入本地待同步队列 → 立即出现在列表里。
    const quickAdd = page.locator(QUICK_ADD_INPUT);
    await quickAdd.fill(OFFLINE_TASK_TITLE);
    await quickAdd.press('Enter');

    await expect(page.getByText(OFFLINE_TASK_TITLE)).toBeVisible();
    // 页面没有被取数错误态接管（离线写入不应把整页打成错误页）。
    await expect(page.getByText('收件箱没能加载')).toHaveCount(0);
  });

  test('恢复联网后离线横幅消失', async ({ context, page }) => {
    await gotoLoadedToday(page);

    const banner = page.locator(OFFLINE_BANNER);
    await expect(banner).toHaveCount(0);

    await context.setOffline(true);
    await expect(banner).toBeVisible();

    await context.setOffline(false);
    await expect(banner).toHaveCount(0);
  });

  test('「禁写断网刷新」负向断言：无 Service Worker 时，断网首访不出现应用内离线兜底', async ({
    browser,
  }) => {
    // 用全新 context：缓存为空，才谈得上「断网首访」。
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/today');
    await expect(page.locator(APP_PAGE)).toBeVisible();

    // 机制侧断言（口径 2 明文「Service Worker 不进本批」）：没有任何 SW 接管，
    // 因此应用**没有能力**在断网时凭空给出一个兜底页。
    const swRegistrations = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) {
        return 0;
      }
      const registrations = await navigator.serviceWorker.getRegistrations();
      return registrations.length;
    });
    expect(swRegistrations, '本批不引入 Service Worker（口径 2）').toBe(0);
    expect(await page.evaluate(() => navigator.serviceWorker?.controller ?? null)).toBeNull();

    // 结果侧断言：断网首访必须失败，即应用不提供「离线也能用」的兜底页。
    // 若这里通过了导航，只能来自 SW 或缓存兜底，二者都属于口径 2 明确排除的行为。
    await context.setOffline(true);

    const offlineVisit = await context.newPage();
    const navigated = await offlineVisit
      .goto('/today', { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    expect(navigated, '断网首访不应成功：成功即意味着存在应用内离线兜底').toBe(false);

    await context.close();
  });
});
