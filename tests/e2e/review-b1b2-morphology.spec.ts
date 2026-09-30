/**
 * 点 13：B1/B2 形态（e2e，P1）。
 *
 * 覆盖（B1/B2 真实口径，《UI 页面规范》v0.21 §5 B1/B2）：
 * - B1：「跳过今天」= 纯前端，不弹确认、不落记录 → 「已跳过今天」状态 → 「补写今天复盘」可恢复
 * - B2：日复盘三问纵向顺序 = completed → blocker → nextAdjustment
 * - B2：周复盘（/review 的「周复盘」分段）「本周计划任务」四 Badge = 完成 / 部分完成 / 跳过 / 延期
 */
import { test, expect } from '@playwright/test';
import { stubReviewData, weeklyReviewData } from './support/api-stub';

test.describe('B1/B2 形态（点 13）', () => {
  test.describe('B1：跳过今天', () => {
    test.beforeEach(async ({ page }) => {
      await stubReviewData(page);
      await page.goto('/review');
      await page.waitForLoadState('networkidle');
    });

    test('跳过今天 = 纯前端，不弹确认', async ({ page }) => {
      const skipButton = page.getByRole('button', { name: '跳过今天' });
      await expect(skipButton).toBeVisible();
      await skipButton.click();

      // 纯前端：不应出现任何确认浮层（Drawer=dialog / ConfirmDialog=alertdialog）
      await expect(page.locator('[role="dialog"], [role="alertdialog"]')).toHaveCount(0);

      // 应出现「已跳过今天」状态
      await expect(page.getByText('已跳过今天')).toBeVisible();
    });

    test('跳过今天后，「补写今天复盘」可恢复', async ({ page }) => {
      const skipButton = page.getByRole('button', { name: '跳过今天' });
      await expect(skipButton).toBeVisible();
      await skipButton.click();

      const resumeButton = page.getByRole('button', { name: '补写今天复盘' });
      await expect(resumeButton).toBeVisible();
      await resumeButton.click();

      // 恢复后应看到三问表单（第一问的输入框可见）
      await expect(page.getByLabel('今天完成了什么')).toBeVisible();
    });
  });

  test.describe('B2：日复盘三问纵向顺序', () => {
    test.beforeEach(async ({ page }) => {
      await stubReviewData(page);
      await page.goto('/review');
      await page.waitForLoadState('networkidle');
    });

    test('三问按 completed → blocker → nextAdjustment 顺序出现', async ({ page }) => {
      const completed = page.getByLabel('今天完成了什么');
      const blocker = page.getByLabel('哪件事最影响计划');
      const next = page.getByLabel('明天要保留、缩小、延期或删除什么');
      await expect(completed).toBeVisible();
      await expect(blocker).toBeVisible();
      await expect(next).toBeVisible();

      // 「纵向顺序」＝三者的屏幕纵坐标递增
      const [completedBox, blockerBox, nextBox] = await Promise.all([
        completed.boundingBox(),
        blocker.boundingBox(),
        next.boundingBox(),
      ]);
      expect(completedBox).not.toBeNull();
      expect(blockerBox).not.toBeNull();
      expect(nextBox).not.toBeNull();
      expect(completedBox!.y).toBeLessThan(blockerBox!.y);
      expect(blockerBox!.y).toBeLessThan(nextBox!.y);
    });
  });

  test.describe('B2：周复盘', () => {
    test.beforeEach(async ({ page }) => {
      // 周复盘 `data: null` 时整段不渲染——要验四枚 Badge 必须给非空载荷。
      await stubReviewData(page, {
        weekly: weeklyReviewData({ completed: 2, partial: 1, deferred: 3, skipped: 4 }),
      });
      await page.goto('/review');
      await page.waitForLoadState('networkidle');
      // B0：默认日复盘，需切到「周复盘」分段
      await page.getByRole('button', { name: '周复盘' }).click();
    });

    test('本周计划任务四 Badge：完成 / 部分完成 / 跳过 / 延期', async ({ page }) => {
      const facts = page.getByRole('region', { name: '本周事实' });
      await expect(facts).toBeVisible();

      await expect(facts.getByText('完成 2', { exact: true })).toBeVisible();
      await expect(facts.getByText('部分完成 1', { exact: true })).toBeVisible();
      await expect(facts.getByText('跳过 4', { exact: true })).toBeVisible();
      await expect(facts.getByText('延期 3', { exact: true })).toBeVisible();
    });
  });
});
