/**
 * 点 12：A6 分类管理交互（e2e，P1）。
 *
 * 覆盖（A6 真实口径，《UI 页面规范》v0.21 §5 A6）：
 * - 新建分类：输入名称 → 新增分类 → 列表出现
 * - 重命名：点击重命名 → 修改名称 → 保存 → 列表更新
 * - 停用：点击停用 → 轻确认 → 分类从活跃列表消失 → 「显示已停用」可恢复
 *
 * A6 的**位置裁定**是 `/expenses` 页内管理区（不进 settings），因此三个用例都在
 * `/expenses` 上跑，定位到 `#expense-categories` 区。
 */
import { test, expect } from '@playwright/test';
import { installExpenseStub } from './support/api-stub';

test.describe('A6 分类管理交互（点 12）', () => {
  test.beforeEach(async ({ page }) => {
    await installExpenseStub(page);
    await page.goto('/expenses');
    await page.waitForLoadState('networkidle');
  });

  test('管理分类入口 + Drawer 内新建不关 Drawer', async ({ page }) => {
    // 1. 筛选条分类选择器尾部的「管理分类」入口 → 滚动到页内管理区
    const manageButton = page.getByRole('button', { name: '管理分类' });
    await expect(manageButton).toBeVisible();
    await manageButton.click();
    await expect(page.locator('#expense-categories')).toBeVisible();

    // 2. 打开「记一笔」Drawer。
    //    空列表时页面上有两枚「记一笔」：列表区上方固定主按钮（A1）与空态操作
    //    （A5）。两者都开同一抽屉，取 DOM 中靠前的那枚（A1 固定入口）以避免
    //    strict mode 违规。
    const addButton = page.getByRole('button', { name: '记一笔' }).first();
    await expect(addButton).toBeVisible();
    await addButton.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();

    // 3. Drawer 内分类选择器尾部「＋ 新建分类」→ 行内输入 → 创建并选中
    await drawer.getByRole('button', { name: '＋ 新建分类' }).click();
    const nameInput = drawer.getByLabel('新分类名称');
    await expect(nameInput).toBeVisible();
    const testName = `Drawer新建${Date.now()}`;
    await nameInput.fill(testName);
    await drawer.getByRole('button', { name: '创建并选中' }).click();

    // 4. Drawer 未关闭（A6：不关闭 Drawer、不导航），且新分类被自动选中
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel('分类（必填）').locator('option:checked')).toHaveText(testName);

    // 5. 新分类同时出现在页内管理区列表里
    await expect(
      page.locator('#expense-categories').getByText(testName, { exact: true }),
    ).toBeVisible();
  });

  test('重命名：点击重命名 → 修改名称 → 保存 → 列表更新', async ({ page }) => {
    const section = page.locator('#expense-categories');

    // 任取一行（行内「重命名」按钮的 aria-label 形如「重命名「餐饮」」）
    const renameButton = section.getByRole('button', { name: '重命名' }).first();
    await expect(renameButton).toBeVisible();
    const originalLabel = await renameButton.getAttribute('aria-label');
    const original = originalLabel?.replace(/^重命名「(.*)」$/, '$1') ?? '';
    expect(original).not.toBe('');

    await renameButton.click();

    const input = section.getByLabel(`重命名「${original}」`);
    await expect(input).toBeVisible();
    const newName = `重命名${Date.now()}`;
    await input.fill(newName);
    await section.getByRole('button', { name: '保存名称' }).click();

    // 旧名消失、新名出现在活跃列表
    await expect(section.getByText(newName, { exact: true })).toBeVisible();
    await expect(section.getByText(original, { exact: true })).toHaveCount(0);
  });

  test('停用：点击停用 → 轻确认 → 分类从活跃列表消失', async ({ page }) => {
    const section = page.locator('#expense-categories');

    const archiveButton = section.getByRole('button', { name: '停用' }).first();
    await expect(archiveButton).toBeVisible();
    const label = await archiveButton.getAttribute('aria-label');
    const name = label?.replace(/^停用「(.*)」$/, '$1') ?? '';
    expect(name).not.toBe('');

    await archiveButton.click();

    // 轻确认弹窗（ConfirmDialog 用 role="alertdialog"）
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('停用这个分类？');
    await dialog.getByRole('button', { name: '停用', exact: true }).click();

    // 分类从活跃列表消失
    await expect(section.getByText(name, { exact: true })).toHaveCount(0);

    // 「显示已停用」展开后可恢复
    const showArchivedSwitch = section.getByRole('switch', { name: '显示已停用' });
    await expect(showArchivedSwitch).toBeVisible();
    await showArchivedSwitch.click();

    const restoreButton = section.getByRole('button', { name: `启用「${name}」` });
    await expect(restoreButton).toBeVisible();
    await restoreButton.click();

    // 恢复后回到活跃列表：行内「启用」按钮消失、名称重新出现在活跃列表
    await expect(section.getByRole('button', { name: `启用「${name}」` })).toHaveCount(0);
    await expect(section.getByText(name, { exact: true })).toBeVisible();
  });
});
