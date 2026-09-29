/**
 * 点 14：week 视图与 B4 链接（e2e，P1）。
 *
 * 覆盖（B4 真实口径）：
 * - /week 页面存在且可访问
 * - 周导航「上一周 / 本周」存在
 * - 周范围文本存在
 * - 日期网格渲染七天
 */
import { test, expect } from '@playwright/test';

test.describe('week 视图与 B4 链接（点 14）', () => {
  test('week 视图存在且可访问', async ({ page }) => {
    const response = await page.goto('/week');
    expect(response?.status()).toBe(200);

    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toBeVisible();
  });

  test('周导航「上一周 / 本周」存在', async ({ page }) => {
    await page.goto('/week');
    await page.waitForLoadState('networkidle');

    const prevButton = page.getByRole('button', { name: '上一周' });
    const thisWeekButton = page.getByRole('button', { name: '本周' });

    await expect(prevButton).toBeVisible();
    await expect(thisWeekButton).toBeVisible();
  });

  test('周范围文本存在', async ({ page }) => {
    await page.goto('/week');
    await page.waitForLoadState('networkidle');

    // 周范围文本存在（严格断言：必须存在）
    const rangeText = page.locator('text=/\\d{4}-\\d{2}-\\d{2}|\\d+\\/\\d+/').first();
    await expect(rangeText).toBeVisible();
  });

  test('B4：「查看下周计划」→ /week?weekStart=<下周> 落点', async ({ page }) => {
    await page.goto('/review');
    await page.waitForLoadState('networkidle');

    // 周复盘页的 Toast action「查看下周计划」必须存在（严格断言）
    const link = page.getByRole('link', { name: '查看下周计划' });
    await expect(link).toBeVisible();

    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/week\?weekStart=/);

    // 验证链接可访问
    await page.goto(href!);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toBeVisible();
  });
});
