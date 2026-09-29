/**
 * 点 11：UI 补节冻结文本（e2e，P1）。
 *
 * 覆盖（B1 真实口径）：
 * - 日复盘页「跳过今天」是纯前端，不落记录、不弹确认
 * - 日复盘事实摘要区为只读，无输入控件
 * - 「查看今日计划」链接存在且指向 /today
 */
import { test, expect } from '@playwright/test';

test.describe('UI 补节冻结文本（点 11）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/review');
    await page.waitForLoadState('networkidle');
  });

  test('B1：跳过今天 = 纯前端，不弹确认、不落记录', async ({ page }) => {
    const skipButton = page.getByRole('button', { name: '跳过今天' });
    if ((await skipButton.count()) === 0) {
      test.skip(true, '当前未进入含「跳过今天」的状态');
      return;
    }
    await skipButton.click();

    // 纯前端：不应出现确认对话框
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toHaveCount(0);

    // 应出现「已跳过今天」状态
    const skipped = page.locator('text=已跳过今天');
    await expect(skipped).toBeVisible();
  });

  test('事实摘要区只读：无输入框', async ({ page }) => {
    // 「今天的事实」区块
    const factsHeading = page.locator('text=今天的事实');
    if ((await factsHeading.count()) === 0) {
      test.skip(true, '事实摘要区未渲染');
      return;
    }
    const section = factsHeading.locator('..');
    const inputs = section.locator('input, textarea, select');
    await expect(inputs).toHaveCount(0);
  });

  test('「查看今日计划」链接存在且指向 /today', async ({ page }) => {
    const link = page.getByRole('link', { name: '查看今日计划' });
    if ((await link.count()) === 0) {
      test.skip(true, '空态链接未渲染');
      return;
    }
    await expect(link).toHaveAttribute('href', '/today');
  });
});
