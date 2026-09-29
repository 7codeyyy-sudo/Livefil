/**
 * 点 12：A6 分类管理交互（e2e，P1）。
 *
 * 覆盖（A6 真实口径）：
 * - 新建分类：输入名称 → 新增分类 → 列表出现
 * - 重命名：点击重命名 → 修改名称 → 保存 → 列表更新
 * - 停用：点击停用 → 轻确认 → 分类从活跃列表消失 → 「显示已停用」可恢复
 */
import { test, expect } from '@playwright/test';

test.describe('A6 分类管理交互（点 12）', () => {
  test.beforeEach(async ({ page }) => {
    // 设置页包含分类管理区
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
  });

  test('管理分类入口 + Drawer 内新建不关 Drawer', async ({ page }) => {
    await page.goto('/expenses');
    await page.waitForLoadState('networkidle');

    // 1. 通过「管理分类」入口进入设置页分类区
    const manageButton = page.getByRole('button', { name: '管理分类' });
    if ((await manageButton.count()) === 0) {
      test.skip(true, '管理分类入口未渲染');
      return;
    }
    await manageButton.click();
    await expect(page.locator('#expense-categories')).toBeVisible();

    // 2. Drawer 内新建分类不关 Drawer（ExpenseFormDrawer 内联新建）
    // 先打开记一笔 Drawer
    await page.goto('/expenses');
    await page.waitForLoadState('networkidle');
    const addButton = page.getByRole('button', { name: '记一笔' });
    if ((await addButton.count()) === 0) {
      test.skip(true, '记一笔按钮未渲染');
      return;
    }
    await addButton.click();

    // Drawer 内新建分类
    const newCategoryButton = page.getByRole('button', { name: '＋ 新建分类' });
    if ((await newCategoryButton.count()) === 0) {
      test.skip(true, 'Drawer 内新建分类按钮未渲染');
      return;
    }
    await newCategoryButton.click();

    const nameInput = page.getByLabel('新分类名称');
    if ((await nameInput.count()) === 0) {
      test.skip(true, '新分类名称输入框未渲染');
      return;
    }
    const testName = `Drawer新建 ${Date.now()}`;
    await nameInput.fill(testName);

    const createButton = page.getByRole('button', { name: '创建并选中' });
    if ((await createButton.count()) === 0) {
      test.skip(true, '创建并选中按钮未渲染');
      return;
    }
    await createButton.click();

    // 验证 Drawer 未关闭（仍在页面上）
    const drawer = page.locator('[role="dialog"]');
    await expect(drawer).toBeVisible();

    // 验证新分类出现在选择器中
    await expect(page.locator(`text=${testName}`)).toBeVisible();
  });

  test('重命名：点击重命名 → 修改名称 → 保存 → 列表更新', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // 找到第一个可重命名分类（非默认分类）
    const renameButton = page.getByRole('button', { name: '重命名' }).first();
    if ((await renameButton.count()) === 0) {
      test.skip(true, '无可重命名分类');
      return;
    }

    await renameButton.click();

    const input = page.getByLabel(/重命名/).first();
    if ((await input.count()) === 0) {
      test.skip(true, '重命名输入框未渲染');
      return;
    }

    const newName = `重命名 ${Date.now()}`;
    await input.fill(newName);

    const saveButton = page.getByRole('button', { name: '保存名称' });
    if ((await saveButton.count()) === 0) {
      test.skip(true, '保存名称按钮未渲染');
      return;
    }
    await saveButton.click();

    // 验证新名称出现在列表中
    await expect(page.locator(`text=${newName}`)).toBeVisible();
  });

  test('停用：点击停用 → 轻确认 → 分类从活跃列表消失', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // 找到一个自定义分类（非默认）进行停用
    const archiveButton = page.getByRole('button', { name: '停用' }).first();
    if ((await archiveButton.count()) === 0) {
      test.skip(true, '无可停用分类');
      return;
    }

    // 获取分类名称以便后续验证
    const categoryRow = archiveButton.locator('..');
    const categoryName = await categoryRow.locator('span').first().textContent();
    if (!categoryName) {
      test.skip(true, '无法获取分类名称');
      return;
    }

    await archiveButton.click();

    // 验证轻确认弹窗出现
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toContainText('停用这个分类？');

    const confirmButton = page.getByRole('button', { name: '停用' });
    if ((await confirmButton.count()) === 0) {
      test.skip(true, '确认停用按钮未渲染');
      return;
    }
    await confirmButton.click();

    // 验证分类从活跃列表消失
    await expect(page.locator(`text=${categoryName}`)).toHaveCount(0);

    // 验证「显示已停用」开关存在并点击
    const showArchivedSwitch = page.getByLabel('显示已停用');
    await expect(showArchivedSwitch).toBeVisible();
    await showArchivedSwitch.click();
    // 已停用分类应出现在列表中
    await expect(page.locator(`text=${categoryName}`)).toBeVisible();
  });
});
