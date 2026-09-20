/**
 * 页面状态的浏览器端验证（UI-004，《UI 页面规范》v0.14 §4.7）。
 *
 * 走**真实路由**（不借助 styleguide 夹具），并用 Playwright 的 `page.route()`
 * 拦截 `/api/v1` 请求来造出四种状态——**刻意不启用浏览器端 MSW**：项目在
 * Node 侧（集成测试）已有 MSW，浏览器侧再引一套 service worker 会让
 * 「拦截发生在哪一层」变得难以判断。
 *
 * 为什么必须在这一层测：真实路由携带了 Next 的客户端导航与水合，而
 * 「点击重试会重新发请求」这类行为只有在真的发请求时才有意义。
 */
import type { Route } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { errorState } from './support/api-stub';

/** 今日页与收件箱页都查任务列表，共用同一个端点。 */
const TASKS_ENDPOINT = '**/api/v1/tasks*';

/** 《接口文档》§1.3 的分页信封，空结果。 */
const EMPTY_ENVELOPE = { data: [], meta: { hasMore: false } };

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test.describe('页面状态（UI-004）', () => {
  test('取数成功但为空：显示今日空态，操作指向真实的收件箱路由', async ({ page }) => {
    await page.route(TASKS_ENDPOINT, (route) => fulfillJson(route, EMPTY_ENVELOPE));

    await page.goto('/today');

    await expect(page.getByText('今天还没有安排')).toBeVisible();

    const action = page.getByRole('link', { name: '去收件箱' });
    await expect(action).toBeVisible();
    // 真链接：有 href，而不是一个靠 onClick 跳转的按钮。
    await expect(action).toHaveAttribute('href', '/inbox');

    await action.click();
    await expect(page).toHaveURL(/\/inbox$/);
    // 收件箱路由同样是真实可达的状态页。
    await expect(page.getByText('收件箱是空的')).toBeVisible();
  });

  test('取数进行中：显示加载骨架并标记 aria-busy，完成后切到空态', async ({ page }) => {
    await page.route(TASKS_ENDPOINT, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await fulfillJson(route, EMPTY_ENVELOPE);
    });

    await page.goto('/today');

    const loading = page.getByRole('status');
    await expect(loading).toHaveAttribute('aria-busy', 'true');
    // 骨架是纯视觉占位，读屏靠视觉隐藏的说明文字（§4.6）。
    await expect(loading).toHaveText('正在加载…');

    await expect(page.getByText('今天还没有安排')).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('取数失败：错误态用主按钮重试，重试后回到正常状态', async ({ page }) => {
    let attempt = 0;
    await page.route(TASKS_ENDPOINT, async (route) => {
      attempt += 1;
      if (attempt === 1) {
        await fulfillJson(
          route,
          { error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } },
          500,
        );
        return;
      }
      await fulfillJson(route, EMPTY_ENVELOPE);
    });

    await page.goto('/today');

    const alert = errorState(page);
    await expect(alert).toBeVisible();
    // 标题来自页面（容器不内置「出错了」这类泛化文案，§4.7）。
    await expect(page.getByText('今日安排没能加载')).toBeVisible();
    await expect(page.getByText('数据没能取回来。可以先重试。')).toBeVisible();

    const retry = page.getByRole('button', { name: '重试' });
    // 近黑主按钮：重试是**肯定动作**，danger 只留给破坏性确认（§4.6）。
    await expect(retry).toHaveCSS('background-color', 'rgb(29, 29, 31)');

    await retry.click();

    // 本批列表渲染属 UI-007，所以「成功」的可观察信号是空态出现
    // （空数组 ⇒ EmptyState）；错误态必须消失。
    await expect(page.getByText('今天还没有安排')).toBeVisible();
    await expect(alert).toHaveCount(0);
  });

  test('失败后不会自动重发：只有点重试才产生第二次请求', async ({ page }) => {
    let attempt = 0;
    await page.route(TASKS_ENDPOINT, async (route) => {
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
    await page.route(TASKS_ENDPOINT, (route) => fulfillJson(route, EMPTY_ENVELOPE));
    await page.goto('/today');
    await expect(page.getByText('今天还没有安排')).toBeVisible();

    const banner = page.getByText('当前处于离线状态，显示的内容可能不是最新');
    await expect(banner).toHaveCount(0);

    await context.setOffline(true);
    await expect(banner).toBeVisible();

    await context.setOffline(false);
    await expect(banner).toHaveCount(0);
  });
});
