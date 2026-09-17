/**
 * 组件浏览器端验证（UI-002 批次 1）。
 *
 * ## 这一层负责什么
 *
 * 视觉与响应：五态的实际呈现、控件几何量、断点覆盖是否真的生效。这些
 * jsdom 一律测不到（它没有布局引擎，也不解析 CSS）。
 *
 * ## 分工（两层不互替）
 *
 * - 行为（ARIA、键盘、状态切换逻辑）→ `tests/integration/ui/*.test.tsx`（vitest）
 * - 视觉与响应 → 本文件（Playwright，双 project 自动覆盖桌面与 Pixel 5 窄屏）
 *
 * ## 为什么不断言截图
 *
 * Linux CI 与本地 Windows 的字体、抗锯齿与渲染管线都不同，截图比对会持续
 * 产生 flaky。这里一律断言 computed style 与几何值——它们跨平台稳定。
 */
import { expect, test } from '@playwright/test';

const STYLEGUIDE_PATH = '/styleguide';

/** 主控件的触控下限（§2.3 / §2.4）。窄屏时令牌会把小控件抬到这个高度。 */
const TOUCH_MIN_PX = 44;

/** 桌面下小控件的基准高度。 */
const CONTROL_SM_PX = 40;

test.describe('五态可见性', () => {
  test('Button：四种强调级与加载、禁用态都渲染出来', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const section = page.locator('#button');

    // 四级强调（§4.1）——每组操作最多一个主按钮，所以这里断言的是"四种都存在"，
    // 而不是"都长得一样"。
    await expect(section.getByRole('button', { name: '保存' }).first()).toBeVisible();
    await expect(section.getByRole('button', { name: '编辑' })).toBeVisible();
    await expect(section.getByRole('button', { name: '稍后处理' })).toBeVisible();
    await expect(section.getByRole('button', { name: '删除' })).toBeVisible();

    // 禁用与加载各自一个。
    const disabled = section.locator('[data-variant="primary-disabled"]');
    await expect(disabled).toBeDisabled();

    const loading = section.locator('[data-variant="primary-loading"]');
    await expect(loading).toBeDisabled();
    await expect(loading).toHaveAttribute('aria-busy', 'true');
  });

  test('Button：主按钮用近黑实心，不是强调色蓝（v0.4 定稿）', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    // 这两个 rgb 对应令牌 --color-primary-surface(#1d1d1f) 与 --color-on-primary(#ffffff)。
    // 断言具体值而不是"等于令牌当前值"，是为了让「改主按钮配色」必须显式改到这里——
    // 配色是产品决策，不该被测试悄悄跟随。
    await expect(page.locator('[data-variant="primary"]')).toHaveCSS(
      'background-color',
      'rgb(29, 29, 31)',
    );
    await expect(page.locator('[data-variant="primary"]')).toHaveCSS('color', 'rgb(255, 255, 255)');
  });

  test('IconButton：无障碍名称可从 role 查询到（label 必填的收益）', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const section = page.locator('#icon-button');

    // 图标按钮没有可见文字，能按名称查到就证明 aria-label 真的接上了。
    await expect(section.getByRole('button', { name: '关闭' }).first()).toBeVisible();
    await expect(section.getByRole('button', { name: '删除' })).toBeVisible();
  });

  test('表单控件的错误态同时有文本与 role=alert，不只靠颜色', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    // 按分区限定 role="alert"：页面上有三个错误字段，而且 Next 还挂着一个
    // 用于路由播报的空 alert——全局查会一次命中多个，strict 模式直接报错。
    for (const [variant, sectionId, label, message] of [
      ['input-error', 'input', '金额', '请输入大于 0 的金额'],
      ['select-error', 'select', '分类', '请选择分类'],
      ['textarea-error', 'textarea', '阻碍', '请至少写 10 个字'],
    ] as const) {
      const control = page.locator(`[data-variant="${variant}"]`);
      const section = page.locator(`#${sectionId}`);

      // 控件被标记为无效
      await expect(control).toHaveAttribute('aria-invalid', 'true');

      // 且错误以 role=alert 播报（§7）
      await expect(section.getByRole('alert')).toContainText(message);

      // 并已通过 aria-describedby 与控件关联——否则读屏用户听不到原因
      await expect(control).toHaveAttribute('aria-describedby', /-error$/);

      // 标签可被查询到，证明 label 的 htmlFor 关联正确（§7）
      await expect(section.getByLabel(label, { exact: false }).first()).toBeVisible();
    }
  });

  test('表单控件的禁用态不可交互', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    await expect(page.locator('[data-variant="input-disabled"]')).toBeDisabled();
    await expect(page.locator('[data-variant="select-disabled"]')).toBeDisabled();
    await expect(page.locator('[data-variant="textarea-disabled"]')).toBeDisabled();
  });
});

test.describe('焦点可见性（§7）', () => {
  test('键盘聚焦后按钮出现可见的焦点环', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const primary = page.locator('[data-variant="primary"]');
    await primary.focus();

    // outline 由令牌提供颜色；这里只断言"确实有可见焦点反馈"。
    const outlineStyle = await primary.evaluate(
      (element) => getComputedStyle(element).outlineStyle,
    );
    const outlineWidth = await primary.evaluate(
      (element) => getComputedStyle(element).outlineWidth,
    );

    expect(outlineStyle).not.toBe('none');
    expect(Number.parseFloat(outlineWidth)).toBeGreaterThan(0);
  });

  test('键盘聚焦后输入框出现焦点环并把边框换成强调色', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const input = page.locator('[data-variant="input-default"]');
    await input.focus();

    await expect(input).toHaveCSS('border-color', 'rgb(23, 105, 224)');
  });
});

test.describe('几何量与断点覆盖', () => {
  test('主控件高度达到当前视口对应的下限', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const width = page.viewportSize()?.width ?? 0;
    const expectedMin = width <= 767 ? TOUCH_MIN_PX : CONTROL_SM_PX;

    for (const selector of ['[data-variant="primary"]', '[data-variant="icon-ghost"]']) {
      const box = await page.locator(selector).boundingBox();
      expect(box, `${selector} 应可测量`).not.toBeNull();
      // 这是 --size-touch-min 的浏览器级牙齿：令牌层的媒体覆盖若失效，
      // 窄屏下这里会立刻掉到 40px 并失败。
      expect(box?.height ?? 0, `${selector} 在 ${String(width)}px 视口下`).toBeGreaterThanOrEqual(
        expectedMin,
      );
    }
  });

  test('输入框高度达到大控件下限（48px / 窄屏仍不少于 48）', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const box = await page.locator('[data-variant="input-default"]').boundingBox();

    expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
  });

  test('字段网格在窄屏收成一列', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const width = page.viewportSize()?.width ?? 0;
    if (width > 767) {
      test.skip(true, '本用例只在窄屏 project 下有判定意义');
    }

    const first = await page.locator('[data-variant="input-default"]').boundingBox();
    const second = await page.locator('[data-variant="input-hint"]').boundingBox();

    // 单列意味着第二个字段排在第一个下方，而不是同一行的右侧。
    expect(second?.y ?? 0).toBeGreaterThan((first?.y ?? 0) + (first?.height ?? 0));
  });
});

test.describe('批次 2：Badge / Progress / Tabs 的语义与状态', () => {
  test('Badge：四个变体都渲染，状态变体有边框、中性没有', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const section = page.locator('#badge');

    // §2.1「颜色不能成为唯一语义载体」：四个变体各自都有文字，
    // 所以颜色只是叠加信息，不是唯一信息。
    for (const text of ['待整理', '已完成', '已延期', '冲突']) {
      await expect(section.getByText(text).first()).toBeVisible();
    }

    // 中性标签无边（§2.4：「中性 Tag 仍用次文字 + 柔和面，不新增边框令牌」）
    await expect(section.locator('[data-variant="neutral"]').first()).toHaveCSS(
      'border-top-color',
      'rgba(0, 0, 0, 0)',
    );

    // 状态变体的边框取语义色（24% alpha）。这里断言具体值而不是「等于令牌当前值」，
    // 理由同批次 1 的主按钮：配色是产品决策，改它必须显式改到这里。
    //
    // `.first()` 是必需的：同一变体可以出现多次（例如两条警告标签），
    // 不加选择器会命中多个元素而触发严格模式报错——那是**测试写法**的错，
    // 不是样式的错。
    for (const [variant, rgb] of [
      ['success', 'rgba(45, 138, 91, 0.24)'],
      ['warning', 'rgba(183, 121, 31, 0.24)'],
      ['danger', 'rgba(192, 57, 43, 0.24)'],
    ] as const) {
      await expect(section.locator(`[data-variant="${variant}"]`).first()).toHaveCSS(
        'border-top-color',
        rgb,
      );
    }
  });

  test('Progress：aria 三属性与可见数值一致', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const section = page.locator('#progress');

    // 四个进度条（含一个不带可见数值的形态）
    await expect(section.getByRole('progressbar')).toHaveCount(4);

    for (const [name, expected] of [
      ['今日完成度', '0'],
      ['目标进度', '58'],
      ['本周预算使用', '100'],
    ] as const) {
      const bar = section.getByRole('progressbar', { name });

      await expect(bar).toHaveAttribute('aria-valuenow', expected);
      await expect(bar).toHaveAttribute('aria-valuemin', '0');
      await expect(bar).toHaveAttribute('aria-valuemax', '100');

      // 屏幕上写的数与朗读的数必须是同一个——读屏听到 58、屏幕写着 58.33
      // 会让「同事说 58%」对不上。
      await expect(section).toContainText(`${expected}%`);
    }
  });

  test('Progress：填充宽度真的反映百分比，不是装饰', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const bar = page.getByRole('progressbar', { name: '目标进度' });
    const track = await bar.boundingBox();
    const fill = await bar.locator('span').boundingBox();

    const ratio = (fill?.width ?? 0) / (track?.width ?? 1);

    // 容差而非等值：亚像素舍入会让 58% 落在 57.9~58.1 之间。
    // 真正要防的是「填充条宽度写死、与 value 无关」这类退化。
    expect(ratio).toBeGreaterThan(0.56);
    expect(ratio).toBeLessThan(0.6);
  });

  test('Tabs：真 Tab 三层语义 + roving tabindex', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const list = page.getByRole('tablist', { name: '添加类型' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('tab')).toHaveCount(3);

    // 有且仅有一个选中项（ARIA 对 tablist 的硬要求）
    await expect(list.getByRole('tab', { name: '任务' })).toHaveAttribute('aria-selected', 'true');
    await expect(list.getByRole('tab', { name: '目标' })).toHaveAttribute('aria-selected', 'false');

    // roving tabindex：Tab 键把标签栏当作一个停靠点，而不是逐项停靠
    await expect(list.getByRole('tab', { name: '任务' })).toHaveAttribute('tabindex', '0');
    await expect(list.getByRole('tab', { name: '目标' })).toHaveAttribute('tabindex', '-1');

    // 未选中的面板是 hidden，因此可见的 tabpanel 恰好一个
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    await expect(page.getByRole('tabpanel')).toContainText('只要求标题');
  });

  test('Tabs：点击与方向键都能切换，且两端回绕', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    await page.getByRole('tab', { name: '目标' }).click();
    await expect(page.getByRole('tabpanel')).toContainText('结果描述');

    // 焦点在标签上时才响应方向键——这也是真实键盘用户的路径
    await page.getByRole('tab', { name: '目标' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: '开销' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toContainText('金额优先');

    // 末项继续右移回绕到首项（键盘操作不留死角）
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: '任务' })).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: '开销' })).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: '目标' })).toHaveAttribute('aria-selected', 'true');
  });

  test('丸形与分段控件的几何：Badge/进度条全圆，Tabs 保持 34px', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    // 丸形令牌（§2.4）：Badge 与进度轨道都是「端帽完全圆化」
    await expect(page.locator('#badge [data-variant="neutral"]').first()).toHaveCSS(
      'border-radius',
      '999px',
    );

    const track = page.getByRole('progressbar', { name: '目标进度' });
    await expect(track).toHaveCSS('border-radius', '999px');
    expect((await track.boundingBox())?.height ?? 0).toBe(6);

    const badge = await page.locator('#badge [data-variant="neutral"]').first().boundingBox();
    expect(badge?.height ?? 0).toBe(24);

    // 分段控件**不参与**移动端触控抬升（§2.4 明文：它不是独立触控目标）。
    // 两条断言在两个 project 下都会跑：若有人顺手把 34px 改成
    // --size-control-sm，窄屏会变成 44px、这里立刻红。
    expect((await page.getByRole('tab', { name: '任务' }).boundingBox())?.height ?? 0).toBe(34);
  });
});

test.describe('减少动效（§6）', () => {
  test.use({ reducedMotion: 'reduce' });

  test('系统要求减少动效时，时长令牌归零', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const durations = await page.evaluate(() => {
      const computed = getComputedStyle(document.documentElement);
      return {
        fast: computed.getPropertyValue('--duration-fast').trim(),
        base: computed.getPropertyValue('--duration-base').trim(),
      };
    });

    // 单点全局覆盖（tokens.css）——若有人把媒体查询删掉、或在组件里各写一份，
    // 这里会失败。
    //
    // 比较**数值**而不是字符串：浏览器会把 `0.01ms` 规范化成 `.01ms`（去掉前导零），
    // 断言字面量会造成假失败。同时断言大于 0——时长真的为 0 会让部分浏览器的
    // transition 事件不触发，依赖 transitionend 的逻辑会静默失效。
    const fast = Number.parseFloat(durations.fast);
    const base = Number.parseFloat(durations.base);

    expect(fast).toBeGreaterThan(0);
    expect(fast).toBeLessThan(1);
    expect(base).toBeGreaterThan(0);
    expect(base).toBeLessThan(1);
  });

  test('减少动效下按钮过渡仍是瞬时完成', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const duration = await page
      .locator('[data-variant="primary"]')
      .evaluate((element) => getComputedStyle(element).transitionDuration);

    // 过渡时长由 --duration-fast 决定，覆盖生效后应当只剩毫秒级的零头。
    const longest = Math.max(...duration.split(',').map((part) => Number.parseFloat(part.trim())));
    expect(longest).toBeLessThan(1);
  });
});

test.describe('页面纪律', () => {
  test('夹具不进任何产品导航，且声明 noindex', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('noindex');

    // 首页不应出现指向夹具的链接——它不是产品的一部分。
    await page.goto('/');
    await expect(page.locator('a[href="/styleguide"]')).toHaveCount(0);
  });

  test('夹具页不产生控制台错误', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(STYLEGUIDE_PATH);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});
