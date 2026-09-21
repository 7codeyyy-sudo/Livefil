/**
 * 设置页的浏览器用例（IAM-002 / IAM-003，《UI 页面规范》v0.16 §5）。
 *
 * 这一层验的是**只有真实浏览器才能验的部分**：分区独立保存、脏状态标记、
 * 路由离开确认、生活领域的增删改与排序、以及"刷新之后改动还在"。
 * 表单逻辑的纯函数部分由 `tests/unit/**` 覆盖，接口的错误码语义由
 * `tests/integration/**` 覆盖。
 *
 * 数据来自状态化的 API 桩（`support/settings-api-stub.ts`）：它在网络边界上
 * 工作，因此"失败 → 错误态 → 重试"这条链路是真的在跑。
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { installSettingsStub } from './support/settings-api-stub';

const SETTINGS_PATH = '/settings';

/** 按标题定位一个设置分区（五个分区都是 `<section aria-labelledby>`）。 */
function section(page: Page, title: string) {
  return page.locator('section[aria-labelledby]').filter({ hasText: title });
}

/** 打开设置页并等待取数完成（分区标题出现即说明成功分支已渲染）。 */
async function openSettings(page: Page): Promise<void> {
  await page.goto(SETTINGS_PATH);
  await expect(page.getByRole('heading', { name: '地区与语言' })).toBeVisible();
}

test.describe('设置页 · 分区与保存', () => {
  test('显示五个分区与数据模式标识', async ({ page }) => {
    await installSettingsStub(page);
    await openSettings(page);

    for (const title of ['生活领域', '地区与语言', '任务默认值', '提醒与安静时段', 'AI 与隐私']) {
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
    }

    // §5：页面顶部显示数据模式标识。
    await expect(page.getByText('本地模式 · 数据仅保存在本环境')).toBeVisible();
  });

  test('改动后出现未保存标记，保存成功后标记消失并给出反馈', async ({ page }) => {
    await installSettingsStub(page);
    await openSettings(page);

    const region = section(page, '地区与语言');
    await expect(region.getByText('未保存')).toHaveCount(0);

    await page.getByLabel('时区').selectOption('Asia/Tokyo');

    // 脏标记只出现在被改动的那个分区，而不是整页一个标记。
    await expect(region.getByText('未保存')).toBeVisible();
    await expect(section(page, '任务默认值').getByText('未保存')).toHaveCount(0);

    await region.getByRole('button', { name: '保存' }).click();

    await expect(page.getByText('设置已保存')).toBeVisible();
    await expect(region.getByText('未保存')).toHaveCount(0);

    // 服务端已经真的收到了这次改动：刷新后仍是新值（桩维护了版本与状态）。
    await page.reload();
    await expect(page.getByLabel('时区')).toHaveValue('Asia/Tokyo');
  });

  test('保存失败时在分区内给出可读的错误，并且不假装成功', async ({ page }) => {
    const stub = await installSettingsStub(page);
    await openSettings(page);

    stub.nextFailure = 'server-error';
    await page.getByLabel('货币代码').fill('USD');
    await section(page, '地区与语言').getByRole('button', { name: '保存' }).click();

    const region = section(page, '地区与语言');
    await expect(region.getByRole('alert')).toContainText('服务端暂时不可用');
    // 失败不该清掉"未保存"：用户还得再试一次。
    await expect(region.getByText('未保存')).toBeVisible();
    await expect(page.getByText('设置已保存')).toHaveCount(0);
  });

  test('版本冲突给出可执行的下一步，而不是"保存失败"', async ({ page }) => {
    const stub = await installSettingsStub(page);
    await openSettings(page);

    stub.nextFailure = 'version-conflict';
    await page.getByLabel('货币代码').fill('USD');
    await section(page, '地区与语言').getByRole('button', { name: '保存' }).click();

    await expect(section(page, '地区与语言').getByRole('alert')).toContainText('已在别处被修改');
  });

  test('保存过程中不会重复提交', async ({ page }) => {
    const stub = await installSettingsStub(page);
    await openSettings(page);

    await page.getByLabel('货币代码').fill('USD');
    const save = section(page, '地区与语言').getByRole('button', { name: '保存' });

    // 连点三次：第一次之后按钮进入 loading 并禁用，动作层还会再挡一次。
    await save.click();
    await expect(page.getByText('设置已保存')).toBeVisible();
    await expect(save).toBeDisabled();

    expect(stub.patchCount).toBe(1);
  });
});

test.describe('设置页 · AI 与隐私', () => {
  test('未同意数据发送时 AI 开关保持关闭并给出说明', async ({ page }) => {
    await installSettingsStub(page);
    await openSettings(page);

    const aiSwitch = page.getByRole('switch', { name: '启用 AI 功能' });
    await aiSwitch.click();

    // §5：未同意时开关保持关闭，并附说明文字（而不是让服务端用 422 打回来）。
    await expect(aiSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText(/请先打开下方的/)).toBeVisible();
  });

  test('同意之后 AI 开关可以打开', async ({ page }) => {
    await installSettingsStub(page);
    await openSettings(page);

    await page.getByRole('switch', { name: '同意将必要数据发送给模型服务' }).click();
    const aiSwitch = page.getByRole('switch', { name: '启用 AI 功能' });
    await aiSwitch.click();

    await expect(aiSwitch).toHaveAttribute('aria-checked', 'true');
  });

  test('撤回同意会同时关闭 AI（不留"已启用但未同意"的组合）', async ({ page }) => {
    await installSettingsStub(page, {
      profile: { aiEnabled: true, aiDataConsent: true },
    });
    await openSettings(page);

    await expect(page.getByRole('switch', { name: '启用 AI 功能' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await page.getByRole('switch', { name: '同意将必要数据发送给模型服务' }).click();

    await expect(
      page.getByRole('switch', { name: '同意将必要数据发送给模型服务' }),
    ).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('switch', { name: '启用 AI 功能' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});

test.describe('设置页 · 生活领域', () => {
  test('新增与重命名，并且刷新后仍在', async ({ page }) => {
    await installSettingsStub(page);
    await openSettings(page);

    await page.getByLabel('新增领域').fill('阅读');
    await page.getByRole('button', { name: '新增领域' }).click();

    // `exact: true` 是必要的：同一行里还有「「阅读」的分类色」这个 label，
    // 模糊匹配会同时命中两个元素，Playwright 的严格模式会直接失败。
    await expect(page.getByText('阅读', { exact: true })).toBeVisible();
    // 新增成功后输入框清空，避免连续两次点到同一个名字。
    await expect(page.getByLabel('新增领域')).toHaveValue('');

    await page.getByRole('button', { name: '重命名「阅读」' }).click();
    await page.getByLabel('重命名「阅读」').fill('深度阅读');
    await page.getByRole('button', { name: '保存名称' }).click();

    await expect(page.getByText('深度阅读', { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByText('深度阅读', { exact: true })).toBeVisible();
  });

  test('同名冲突时把服务端的话原样告诉用户', async ({ page }) => {
    await installSettingsStub(page);
    await openSettings(page);

    await page.getByLabel('新增领域').fill('工作');
    await page.getByRole('button', { name: '新增领域' }).click();

    // 限定在生活领域分区内：Next 的 RouteAnnouncer 也带 `role="alert"`，
    // 全局查询会与它撞上（这是本项目踩过两次的坑）。
    await expect(section(page, '生活领域').getByRole('alert')).toContainText(
      '已存在同名的未归档领域',
    );
  });

  test('上移改变顺序', async ({ page }) => {
    await installSettingsStub(page);
    await openSettings(page);

    const rows = page.locator('li').filter({ hasNot: page.getByText('已归档') });
    await expect(rows.first()).toContainText('工作');

    await page.getByRole('button', { name: '把「健康」上移' }).click();

    await expect(rows.first()).toContainText('健康');
  });

  test('归档需轻确认，归档后进"显示已归档"，可恢复', async ({ page }) => {
    await installSettingsStub(page);
    await openSettings(page);

    await page.getByRole('button', { name: '归档「健康」' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('归档这个生活领域？');
    // 轻确认：说明是可恢复的，且确认按钮写"归档"而不是"删除"。
    await expect(dialog).toContainText('可以');
    await dialog.getByRole('button', { name: '归档' }).click();

    await expect(page.getByRole('button', { name: '归档「健康」' })).toHaveCount(0);

    await page.getByRole('switch', { name: '显示已归档' }).click();
    await expect(page.getByText('已归档', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '恢复「健康」' }).click();
    await expect(page.getByRole('button', { name: '归档「健康」' })).toBeVisible();
  });
});

test.describe('设置页 · 脏状态与响应式', () => {
  test('带着未保存的修改点击导航会先确认', async ({ page }) => {
    test.skip(
      (page.viewportSize()?.width ?? 0) <= 767,
      '窄屏下导航在抽屉里，不需要这条路径（同一机制已在桌面档覆盖）',
    );

    await installSettingsStub(page);
    await openSettings(page);

    await page.getByLabel('货币代码').fill('USD');
    await page.getByRole('link', { name: '目标' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('离开设置页？');
    await expect(page).toHaveURL(new RegExp(`${SETTINGS_PATH}$`));

    // 取消后留在原页，且改动还在。
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(page).toHaveURL(new RegExp(`${SETTINGS_PATH}$`));
    await expect(page.getByLabel('货币代码')).toHaveValue('USD');

    // 确认后才真的离开。
    await page.getByRole('link', { name: '目标' }).click();
    await page.getByRole('button', { name: '放弃修改并离开' }).click();
    await expect(page).toHaveURL(/\/goals$/);
  });

  test('没有未保存修改时导航不弹确认', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) <= 767, '窄屏下导航在抽屉里，桌面档已覆盖同一机制');

    await installSettingsStub(page);
    await openSettings(page);

    await page.getByRole('link', { name: '目标' }).click();

    await expect(page).toHaveURL(/\/goals$/);
  });

  test('设置页不产生横向溢出', async ({ page }) => {
    await installSettingsStub(page, {
      lifeAreas: [
        {
          id: 'area-1',
          name: '工作',
          colorKey: 'blue',
          sortOrder: 0,
          isDefault: true,
          isArchived: false,
          version: 1,
        },
        {
          id: 'area-2',
          name: '一个名字比较长的生活领域',
          colorKey: 'green',
          sortOrder: 1,
          isDefault: false,
          isArchived: false,
          version: 1,
        },
      ],
    });
    await openSettings(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(overflow, '设置页不应出现横向滚动').toBeLessThanOrEqual(1);
  });
});
