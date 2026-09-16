/**
 * 首页端到端测试（FND-003）。
 *
 * 这些用例在**真实浏览器**里驱动**真实构建产物**，与集成测试的分工是：
 * 集成测试验证接口契约与组件行为（进程内），E2E 验证它们被装配起来之后仍然可用。
 *
 * 两种视口（桌面 / 移动）由 `playwright.config.ts` 的 projects 提供，
 * 因此用例本身不需要为设备差异写分支——同一份断言在两套设备配置下各跑一次。
 */
import { expect, test } from '@playwright/test';

test('首页渲染标题与骨架说明', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Livefil');
  await expect(page.getByText('工程骨架已就绪')).toBeVisible();
});

test('健康检查接口可通过真实 HTTP 访问', async ({ request }) => {
  const response = await request.get('/api/v1/health');

  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: 'ok' });
});

test('页面不产生控制台错误', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // 页面能渲染不代表没有报错。把控制台错误当成失败，
  // 才不会让「渲染成功但后台一直在报」这类问题溜进后续阶段。
  expect(consoleErrors).toEqual([]);
});
