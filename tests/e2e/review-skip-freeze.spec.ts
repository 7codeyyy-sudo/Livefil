/**
 * 点 11：UI 补节冻结文本（e2e，P1）。
 *
 * 覆盖（《UI 页面规范》v0.21 §5 B1 冻结口径）：
 * - 日复盘页「跳过今天」是纯前端，不落记录、不弹确认
 * - 日复盘事实摘要区为只读，无输入控件
 * - 「查看今日计划」链接存在且指向 /today（空态次操作）
 */
import { test, expect } from '@playwright/test';
import { stubReviewData } from './support/api-stub';

test.describe('UI 补节冻结文本（点 11）', () => {
  test.beforeEach(async ({ page }) => {
    await stubReviewData(page);
    await page.goto('/review');
    await page.waitForLoadState('networkidle');
  });

  test('B1：跳过今天 = 纯前端，不弹确认、不落记录', async ({ page }) => {
    const skipButton = page.getByRole('button', { name: '跳过今天' });
    await expect(skipButton).toBeVisible();
    await skipButton.click();

    // 纯前端：不应出现任何确认浮层（Drawer=dialog / ConfirmDialog=alertdialog）
    await expect(page.locator('[role="dialog"], [role="alertdialog"]')).toHaveCount(0);

    // 行内转「已跳过今天」态，而非落一条记录
    await expect(page.getByText('已跳过今天')).toBeVisible();
  });

  test('事实摘要区只读：无输入框', async ({ page }) => {
    // 「今天的事实」区块（<section aria-label="今天的事实摘要">）
    const facts = page.getByRole('region', { name: '今天的事实摘要' });
    await expect(facts).toBeVisible();
    await expect(facts.getByRole('heading', { name: '今天的事实' })).toBeVisible();
    await expect(facts.locator('input, textarea, select')).toHaveCount(0);
  });

  test('「查看今日计划」链接存在且指向 /today', async ({ page }) => {
    const link = page.getByRole('link', { name: '查看今日计划' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/today');
  });
});
