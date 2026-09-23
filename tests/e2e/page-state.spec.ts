/**
 * 页面状态的浏览器端验证（UI-004 §4.7；2026-09-22 随 UI-007 按新口径重写）。
 *
 * 今日页自 UI-007 走 **`GET /today` 一屏聚合**（不再查 `/tasks`），
 * 取数状态由 `useAsyncQuery` 承担：loading（role=status + aria-busy）、
 * error（近黑重试按钮、不自动重试）、success（聚合渲染）。
 * 用 `page.route()` 拦截 `/api/v1` 造状态——刻意不启用浏览器端 MSW
 * （拦截层唯一性，见原 UI-004 说明）。
 */
import type { Route } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { errorState } from './support/api-stub';

const TODAY_ENDPOINT = '**/api/v1/today*';

/** 空今日聚合（§6 全字段的空形态）。 */
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

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test.describe('页面状态（今日页四态）', () => {
  test('取数成功但为空：空态文案与去收件箱的真链接可用', async ({ page }) => {
    await page.route(TODAY_ENDPOINT, (route) =>
      fulfillJson(route, { data: EMPTY_TODAY, meta: { requestId: 'e2e' } }),
    );
    await page.route('**/api/v1/tasks?*', (route) =>
      fulfillJson(route, { data: { items: [] }, meta: { nextCursor: null, hasMore: false } }),
    );

    await page.goto('/today');

    await expect(page.getByText('今天还没有排时间块')).toBeVisible();

    // 真链接：有 href，而不是一个靠 onClick 跳转的按钮。
    const action = page.getByRole('link', { name: '去收件箱' });
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute('href', '/inbox');

    await action.click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByText('收件箱是空的')).toBeVisible();
  });

  test('取数进行中：显示加载骨架并标记 aria-busy，完成后切到正常内容', async ({ page }) => {
    await page.route(TODAY_ENDPOINT, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await fulfillJson(route, { data: EMPTY_TODAY, meta: { requestId: 'e2e' } });
    });

    await page.goto('/today');

    const loading = page.getByRole('status');
    await expect(loading).toHaveAttribute('aria-busy', 'true');

    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByText('时间线')).toBeVisible();
  });

  test('取数失败：错误态用主按钮重试，重试后回到正常状态', async ({ page }) => {
    let attempt = 0;
    await page.route(TODAY_ENDPOINT, async (route) => {
      attempt += 1;
      if (attempt === 1) {
        await fulfillJson(
          route,
          { error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } },
          500,
        );
        return;
      }
      await fulfillJson(route, { data: EMPTY_TODAY, meta: { requestId: 'e2e' } });
    });

    await page.goto('/today');

    const alert = errorState(page);
    await expect(alert).toBeVisible();
    await expect(page.getByText('今日安排没能加载')).toBeVisible();

    const retry = page.getByRole('button', { name: '重试' });
    // 近黑主按钮：重试是**肯定动作**（§4.6）。
    await expect(retry).toHaveCSS('background-color', 'rgb(29, 29, 31)');

    await retry.click();

    await expect(page.getByText('时间线')).toBeVisible();
    await expect(alert).toHaveCount(0);
  });

  test('失败后不会自动重发：只有点重试才产生第二次请求', async ({ page }) => {
    let attempt = 0;
    await page.route(TODAY_ENDPOINT, async (route) => {
      attempt += 1;
      await fulfillJson(route, { error: { code: 'INTERNAL_ERROR', message: '挂了' } }, 500);
    });

    await page.goto('/today');
    await expect(errorState(page)).toBeVisible();
    expect(attempt).toBe(1);

    // §4.7 明确不自动重试。给足自动重试可能出现的时间窗。
    await page.waitForTimeout(1200);
    expect(attempt).toBe(1);
    await expect(errorState(page)).toBeVisible();
  });

  test('离线时出现横幅，恢复在线后消失', async ({ context, page }) => {
    await page.route(TODAY_ENDPOINT, (route) =>
      fulfillJson(route, { data: EMPTY_TODAY, meta: { requestId: 'e2e' } }),
    );
    await page.goto('/today');
    await expect(page.getByText('时间线')).toBeVisible();

    const banner = page.getByText('当前处于离线状态，显示的内容可能不是最新');
    await expect(banner).toHaveCount(0);

    await context.setOffline(true);
    await expect(banner).toBeVisible();

    await context.setOffline(false);
    await expect(banner).toHaveCount(0);
  });
});
