/**
 * 设置页的浏览器用例（IAM-002 / IAM-003 → PM-20261012-008 提案 A 两栏化）。
 *
 * 这一层验的是**只有真实浏览器才能验的部分**：栏结构与独立 URL、分区独立保存、
 * 脏状态标记、栏间切换的草稿存续、生活领域的增删改与排序、分区 8 补渲染与
 * 知情 Modal、以及"刷新之后改动还在"。
 *
 * 原「路由离开确认」两用例随提案 2.2.3（移除跨栏离开确认）一并改写为
 * 「切栏不弹确认 + 草稿跨栏存续」——被测行为本身变了，断言跟着行为走。
 *
 * 表单逻辑的纯函数部分由 `tests/unit/**` 覆盖，接口的错误码语义由
 * `tests/integration/**` 覆盖。
 *
 * 数据来自状态化的 API 桩（`support/settings-api-stub.ts`）：它在网络边界上
 * 工作，因此"失败 → 错误态 → 重试"这条链路是真的在跑。
 *
 * 打开设置前一律把新手导览置为「已跳过」：导览的触发与推进有自己的用例面
 * （`ai-ui-panel.spec.ts`），不属本文件——不让全屏引导层给这里的点击制造
 * 偶发拦截（旧版靠撞时机，外观用例里那句 `Esc` 就是补丁）。
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { installSettingsStub } from './support/settings-api-stub';

/** 几个高频栏的 URL 常量（打开动作与 URL 断言共用，避免两处漂移）。 */
const COLUMNS = {
  general: '/settings/general',
  appearance: '/settings/appearance',
  aiPrivacy: '/settings/ai-privacy',
  lifeAreas: '/settings/life-areas',
} as const;

/** 按标题定位一个设置分区（各分区都是 `<section aria-labelledby>`）。 */
function section(page: Page, title: string) {
  return page.locator('section[aria-labelledby]').filter({ hasText: title });
}

/** 把新手导览置为「已跳过」（须在导航前执行；每次导航都会重新注入）。 */
async function skipTour(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'livefil.guide-tour.v1',
      JSON.stringify({ seen: {}, skipped: true }),
    );
  });
}

/** 打开某个设置栏并等待取数完成（栏名 h1 出现即说明成功分支已渲染）。 */
async function openColumn(page: Page, path: string, heading: string): Promise<void> {
  await skipTour(page);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

test.describe('设置页 · 栏结构与分区分布', () => {
  test('各栏渲染对应分区，数据模式标识在壳层常驻', async ({ page }) => {
    await installSettingsStub(page);
    await skipTour(page);

    const expectations: readonly {
      readonly path: string;
      readonly column: string;
      readonly sections: readonly string[];
    }[] = [
      { path: COLUMNS.general, column: '通用', sections: ['地区与语言', '任务默认值'] },
      { path: '/settings/notifications', column: '提醒与通知', sections: ['提醒与安静时段'] },
      { path: '/settings/data', column: '数据管理', sections: ['数据管理'] },
      { path: COLUMNS.aiPrivacy, column: 'AI 与隐私', sections: ['AI 与隐私'] },
      { path: COLUMNS.lifeAreas, column: '生活领域', sections: ['生活领域'] },
      { path: COLUMNS.appearance, column: '外观', sections: ['外观'] },
    ];

    for (const { path, column, sections } of expectations) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: column, level: 1 })).toBeVisible();
      for (const title of sections) {
        await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();
      }
    }

    // §5：页面顶部显示数据模式标识——它在壳层，任何栏都可见。
    await expect(page.getByText('本地模式 · 数据仅保存在本环境')).toBeVisible();
  });

  test('桌面端 /settings 落到首栏；local 态没有账号栏', async ({ page }) => {
    test.skip(
      (page.viewportSize()?.width ?? 0) <= 767,
      '窄屏下 /settings 是栏列表，不重定向（移动端用例另行覆盖）',
    );
    await installSettingsStub(page);
    await skipTour(page);

    // 旧地址兼容：/settings → 首栏。stub 为 local 态，账号栏不存在（§5 分区 9 /
    // C4），可见首栏＝外观。
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    await expect(page.getByRole('heading', { name: '外观', level: 1 })).toBeVisible();

    // 直达账号栏 URL 同样落到可见首栏，不渲染空栏。
    await page.goto('/settings/account');
    await expect(page).toHaveURL(/\/settings\/appearance$/);
  });

  test('移动端 /settings 是栏列表，点进单栏可返回', async ({ page }) => {
    test.skip(
      (page.viewportSize()?.width ?? 0) > 767,
      '桌面档下 /settings 直接重定向到首栏（移动端列表→详情→返回链路在窄屏档覆盖）',
    );
    await installSettingsStub(page);
    await skipTour(page);

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();

    await page.getByRole('link', { name: '提醒与通知' }).click();
    await expect(page).toHaveURL(/\/settings\/notifications$/);
    await expect(page.getByRole('heading', { name: '提醒与通知', level: 1 })).toBeVisible();

    // 栏页的显式返回链（移动端除系统返回外的出口）。
    await page.getByRole('link', { name: '‹ 设置' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
  });
});

test.describe('设置页 · 分区与保存', () => {
  test('改动后出现未保存标记，保存成功后标记消失并给出反馈', async ({ page }) => {
    await installSettingsStub(page);
    await openColumn(page, COLUMNS.general, '通用');

    const region = section(page, '地区与语言');
    await expect(region.getByText('未保存')).toHaveCount(0);

    await page.getByLabel('时区').selectOption('Asia/Tokyo');

    // 脏标记只出现在被改动的那个分区，而不是整栏一个标记。
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
    await openColumn(page, COLUMNS.general, '通用');

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
    await openColumn(page, COLUMNS.general, '通用');

    stub.nextFailure = 'version-conflict';
    await page.getByLabel('货币代码').fill('USD');
    await section(page, '地区与语言').getByRole('button', { name: '保存' }).click();

    await expect(section(page, '地区与语言').getByRole('alert')).toContainText('已在别处被修改');
  });

  test('保存过程中不会重复提交', async ({ page }) => {
    const stub = await installSettingsStub(page);
    await openColumn(page, COLUMNS.general, '通用');

    await page.getByLabel('货币代码').fill('USD');
    const save = section(page, '地区与语言').getByRole('button', { name: '保存' });

    // 连点三次：第一次之后按钮进入 loading 并禁用，动作层还会再挡一次。
    await save.click();
    await expect(page.getByText('设置已保存')).toBeVisible();
    await expect(save).toBeDisabled();

    expect(stub.patchCount).toBe(1);
  });
});

test.describe('设置页 · 外观', () => {
  test('选择暗色/亮色立即落 data-theme（即时生效、无保存动作）', async ({ page }) => {
    await installSettingsStub(page);
    await openColumn(page, COLUMNS.appearance, '外观');

    const appearance = section(page, '外观');
    await appearance.getByText('暗色', { exact: true }).click();

    // 即时生效：属性落 `<html>` 单一节点（v0.29 UI-012 激活协议）。
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('dark');

    // 回切亮色同样即时生效。
    await appearance.getByText('亮色', { exact: true }).click();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('light');

    // 本区是即时偏好：不产生「未保存」脏标记。
    await expect(page.getByText('未保存')).toHaveCount(0);
  });
});

test.describe('设置页 · AI 与隐私', () => {
  test('未同意数据发送时 AI 开关保持关闭并给出说明', async ({ page }) => {
    await installSettingsStub(page);
    await openColumn(page, COLUMNS.aiPrivacy, 'AI 与隐私');

    const aiSwitch = page.getByRole('switch', { name: '启用 AI 功能' });
    await aiSwitch.click();

    // §5：未同意时开关保持关闭，并附说明文字（而不是让服务端用 422 打回来）。
    await expect(aiSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText(/请先打开下方的/)).toBeVisible();
  });

  test('同意之后 AI 开关可以打开', async ({ page }) => {
    await installSettingsStub(page);
    await openColumn(page, COLUMNS.aiPrivacy, 'AI 与隐私');

    await page.getByRole('switch', { name: '同意将必要数据发送给模型服务' }).click();
    const aiSwitch = page.getByRole('switch', { name: '启用 AI 功能' });
    await aiSwitch.click();

    await expect(aiSwitch).toHaveAttribute('aria-checked', 'true');
  });

  test('撤回同意会同时关闭 AI（不留"已启用但未同意"的组合）', async ({ page }) => {
    await installSettingsStub(page, {
      profile: { aiEnabled: true, aiDataConsent: true },
    });
    await openColumn(page, COLUMNS.aiPrivacy, 'AI 与隐私');

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

test.describe('设置页 · 分区 8 测试与隐私说明（补渲染）', () => {
  test('两段冻结文案可见，重看入口唤起首次知情 Modal', async ({ page }) => {
    await installSettingsStub(page);
    await openColumn(page, COLUMNS.aiPrivacy, 'AI 与隐私');

    // 分区 8 归 AI 与隐私栏（提案 2.1 第 4 栏）：此前渲染缺失，走查实录零命中。
    // `exact: true` 是必要的：h2 栏分区标题「测试与隐私说明」是「隐私说明」的
    // 超串，模糊匹配会连它一起命中（严格模式撞车）。
    const notice = section(page, '测试与隐私说明');
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('heading', { name: '测试说明', exact: true })).toBeVisible();
    await expect(notice.getByRole('heading', { name: '隐私说明', exact: true })).toBeVisible();

    // 测试说明首条 + 隐私说明第 1 条的 local 形态（由 GET /me 的 mode 驱动分句）。
    await expect(page.getByText('本次为邀请测试（首批 5–20 人）')).toBeVisible();
    await expect(page.getByText('数据保存在当前环境的数据库中（本地模式）')).toBeVisible();
    // 冻结占位：契约未定稿前逐字渲染，不虚构联系方式。
    await expect(page.getByText('〔随契约定，本稿不虚构〕')).toBeVisible();

    // 区底次按钮＝真实功能：唤起首次知情 Modal（A 节冻结标题与三行）。
    await page.getByRole('button', { name: '重新查看隐私说明' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('开始前，先知道这三件事');
    await expect(dialog).toContainText('可导出、可删除');
    await expect(dialog.getByRole('button', { name: '我知道了' })).toBeVisible();

    await dialog.getByRole('button', { name: '我知道了' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('设置页 · 生活领域', () => {
  test('新增与重命名，并且刷新后仍在', async ({ page }) => {
    await installSettingsStub(page);
    await openColumn(page, COLUMNS.lifeAreas, '生活领域');

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
    await openColumn(page, COLUMNS.lifeAreas, '生活领域');

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
    await openColumn(page, COLUMNS.lifeAreas, '生活领域');

    const rows = page.locator('li').filter({ hasNot: page.getByText('已归档') });
    await expect(rows.first()).toContainText('工作');

    await page.getByRole('button', { name: '把「健康」上移' }).click();

    await expect(rows.first()).toContainText('健康');
  });

  test('归档需轻确认，归档后进"显示已归档"，可恢复', async ({ page }) => {
    await installSettingsStub(page);
    await openColumn(page, COLUMNS.lifeAreas, '生活领域');

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

test.describe('设置页 · 脏状态与栏间切换', () => {
  test('带着未保存的修改切栏不弹确认，草稿跨栏存续', async ({ page }) => {
    test.skip(
      (page.viewportSize()?.width ?? 0) <= 767,
      '窄屏无 rail，栏间切换走「列表→详情」链路（移动端行为在窄屏档用例覆盖）',
    );

    await installSettingsStub(page);
    await openColumn(page, COLUMNS.general, '通用');

    await page.getByLabel('货币代码').fill('USD');
    await page.getByRole('link', { name: '外观', exact: true }).click();

    await expect(page).toHaveURL(/\/settings\/appearance$/);
    // 提案 2.2.3（根治项）：切栏不弹任何离开确认——原生 beforeunload 框与
    // 自绘确认弹窗都已随守卫移除。
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    await page.getByRole('link', { name: '通用', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/general$/);
    // 草稿随布局级 Provider 存续：改动还在，且仍标记未保存（只差一次保存）。
    await expect(page.getByLabel('货币代码')).toHaveValue('USD');
    await expect(section(page, '地区与语言').getByText('未保存')).toBeVisible();
  });

  test('没有未保存修改时导航直接走', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) <= 767, '窄屏下导航在抽屉里，桌面档已覆盖同一机制');

    await installSettingsStub(page);
    await openColumn(page, COLUMNS.general, '通用');

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
    await openColumn(page, COLUMNS.lifeAreas, '生活领域');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(overflow, '设置页不应出现横向滚动').toBeLessThanOrEqual(1);
  });
});
