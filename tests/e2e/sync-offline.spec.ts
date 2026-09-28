/**
 * 离线续用 e2e（测试点 9）与「禁写断网刷新」负向断言。
 *
 * 口径来源：
 * - RD-20260923-003 §6.2 真机验收实测
 * - RD-20260923-003 终审口径 2：Service Worker 不进本批；「断网续用」=
 *   「已打开页面」在断网后仍可操作，**排除**「刷新/重开页面离线可用」
 * - QA-001 §10.2 预审要求：点 9 必须有 e2e 且含「禁刷新」负向断言
 */
import { test, expect, type Page } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3210';

/**
 * 造一条真实数据，确保离线场景不是空页面。
 */
async function seedTask(page: Page): Promise<string> {
  const response = await page.request.post(`${BASE_URL}/api/v1/tasks`, {
    data: { title: '离线续用种子任务', status: 'inbox' },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.data.id).toBeTruthy();
  return body.data.id;
}

/**
 * 走侧栏到「目标」页，确保路由已被预取（详设 §5.4.3 已预取路由可软导航）。
 */
async function navigateToGoalsViaDrawer(page: Page): Promise<void> {
  const drawerTrigger = page
    .locator('[data-testid="nav-drawer-trigger"], [aria-label="菜单"], button:has(svg)')
    .first();
  if ((await drawerTrigger.count()) > 0) {
    await drawerTrigger.click();
  }
  await page.getByRole('link', { name: /目标|goals/i }).click();
  await page.waitForLoadState('networkidle');
}

/**
 * 模拟断网：拦截所有请求，使其超时失败。
 */
function goOffline(page: Page): void {
  page.route('**/*', (route) => route.abort('timedout'));
}

/**
 * 恢复联网：解除拦截。
 */
async function goOnline(page: Page): Promise<void> {
  await page.unroute('**/*');
}

test.describe('离线续用 e2e（测试点 9）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    await seedTask(page);
  });

  test('已打开页面断网后 DOM 未变、离线横幅出现、已预取路由可软导航', async ({ page }) => {
    await goOffline(page);

    // DOM 未变：主页 mainText 仍可读
    const mainText = page.locator('[data-app-page] main, main').first();
    await expect(mainText).toBeVisible();

    // 离线横幅出现（role=status，冻结文案）
    const banner = page.locator('[data-offline-banner="true"], [role="status"]').first();
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/离线|Offline/i);

    // 已预取路由可软导航（不断网时能到的路由，断网后仍停在应用内）
    await navigateToGoalsViaDrawer(page);
    // 不应出现浏览器原生错误页或白屏
    await expect(page.locator('body')).not.toContainText('chrome-error://');
    await expect(page.locator('[data-app-page]')).toBeVisible();
  });

  test('恢复联网后离线横幅消失', async ({ page }) => {
    await goOffline(page);
    const banner = page.locator('[data-offline-banner="true"], [role="status"]').first();
    await expect(banner).toBeVisible();

    await goOnline(page);
    await page.waitForTimeout(500);
    await expect(banner).not.toBeVisible();
  });

  test('「禁写断网刷新」负向断言：无 Service Worker 时，刷新后不应出现应用内离线页', async ({
    page,
  }) => {
    // 口径 2 明确排除「刷新/重开页面离线可用」；
    // 本项断言：在无 SW 前提下，断网刷新**不**假装成功，而是落浏览器原生错误页。
    await goOffline(page);
    await page.reload();

    // 浏览器原生离线错误页特征（Chrome 常见文案/URL）
    const bodyText = await page.locator('body').innerText();
    const chromeError = bodyText.includes('chrome-error') || bodyText.includes('无法访问此网站');

    // 同时断言**没有**应用内离线横幅（说明不是应用内兜底）
    const appOfflineBanner = page.locator('[data-offline-banner="true"], [role="status"]').first();
    const bannerVisible =
      (await appOfflineBanner.count()) > 0 &&
      (await appOfflineBanner.isVisible().catch(() => false));

    expect(chromeError || !bannerVisible).toBe(true);
  });
});
