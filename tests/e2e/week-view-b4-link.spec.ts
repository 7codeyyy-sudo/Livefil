/**
 * 点 14：week 视图与 B4 链接（e2e，P1）。
 *
 * 覆盖（《UI 页面规范》§5 B4 / doc/06 REVIEW-003 第 3 项）：
 * - `/week` 页面存在且可访问（含七日网格）
 * - 周导航「上一周 / 本周」存在
 * - 周范围文本存在（B2 明文形状 `09-22 – 09-28`）
 * - B4「查看下周计划」→ `/week?weekStart=<下周起点>` 落点正确
 */
import { test, expect } from '@playwright/test';
import { stubReviewData, stubWeekScheduleData, weeklyReviewData } from './support/api-stub';

/** 七个日列的 `aria-label` 形态（`YYYY-MM-DD`）。 */
const DAY_COLUMN = /^\d{4}-\d{2}-\d{2}$/;

test.describe('week 视图与 B4 链接（点 14）', () => {
  test('week 视图存在且可访问', async ({ page }) => {
    await stubReviewData(page);
    await stubWeekScheduleData(page);
    const response = await page.goto('/week');
    expect(response?.status()).toBe(200);

    await page.waitForLoadState('networkidle');
    // 七日网格渲染
    await expect(page.getByRole('region', { name: DAY_COLUMN })).toHaveCount(7);
  });

  test('周导航「上一周 / 本周」存在', async ({ page }) => {
    await stubReviewData(page);
    await stubWeekScheduleData(page);
    await page.goto('/week');
    await page.waitForLoadState('networkidle');

    const prevButton = page.getByRole('button', { name: '上一周', exact: true });
    const thisWeekButton = page.getByRole('button', { name: '本周', exact: true });

    await expect(prevButton).toBeVisible();
    await expect(thisWeekButton).toBeVisible();
  });

  test('周范围文本存在', async ({ page }) => {
    await stubReviewData(page);
    await stubWeekScheduleData(page);
    await page.goto('/week');
    await page.waitForLoadState('networkidle');

    // 范围文案形状：`MM-DD – MM-DD`（B2 明文形状，见 review-api.formatWeekRange）
    const rangeText = page.locator('p').filter({ hasText: /^\d{2}-\d{2}/ });
    await expect(rangeText).toHaveCount(1);
    await expect(rangeText).toHaveText(/^\d{2}-\d{2} – \d{2}-\d{2}$/);
  });

  test('B4：「查看下周计划」→ /week?weekStart=<下周> 落点', async ({ page }) => {
    await stubReviewData(page, { weekly: weeklyReviewData() });
    await stubWeekScheduleData(page);
    await page.goto('/review');
    await page.waitForLoadState('networkidle');
    // B0：默认日复盘，切到「周复盘」分段，其「下周调整确认」段尾部即 B4 固定链接
    await page.getByRole('button', { name: '周复盘' }).click();

    const link = page.getByRole('link', { name: '查看下周计划' });
    await expect(link).toBeVisible();

    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/week\?weekStart=\d{4}-\d{2}-\d{2}$/);

    // 落点必须是该 `weekStart` 那一周（不是恒等于本周）
    const weekStart = new URL(href!, 'http://stub').searchParams.get('weekStart') ?? '';
    await page.goto(href!);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('region', { name: DAY_COLUMN })).toHaveCount(7);
    await expect(
      page.locator('p').filter({ hasText: new RegExp(`^${weekStart.slice(5)}`) }),
    ).toBeVisible();
  });
});
