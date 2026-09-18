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

test.describe('批次 3a：Modal / ConfirmDialog 的浮层行为', () => {
  test('未打开时不渲染任何浮层', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    // 浮层挂到 body 下，如果初始就渲染会盖住整页。这条断言同时守着
    // 「Portal 的 SSR 守卫没把内容提前渲出来」。
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('Modal：语义、滚动锁与初始焦点都到位', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);
    await page.locator('[data-variant="open-modal"]').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // 无障碍名称来自标题——读屏用户听到的是「编辑任务」而不是「对话框」
    await expect(dialog).toHaveAccessibleName('编辑任务');

    // 打开时锁定背景滚动，否则滚轮会把浮层下面的页面滚走
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    // 初始焦点必须已经进入面板，否则键盘用户还停在背景页面上
    const focusInPanel = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]');
      const active = document.activeElement;
      return panel !== null && active !== null && panel.contains(active);
    });
    expect(focusInPanel).toBe(true);
  });

  test('Modal：Tab 在面板内循环，焦点不会逃到背景', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);
    await page.locator('[data-variant="open-modal"]').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    // 面板内可聚焦元素有四个（关闭 X / 取消 / 保存 / 删除）。
    // 连按两轮 Tab 都应留在面板内；不循环的话第一轮结束就会跳到背景。
    for (let index = 1; index <= 8; index += 1) {
      await page.keyboard.press('Tab');

      const focusInPanel = await page.evaluate(() => {
        const panel = document.querySelector('[role="dialog"]');
        const active = document.activeElement;
        return panel !== null && active !== null && panel.contains(active);
      });

      expect(focusInPanel, `第 ${String(index)} 次 Tab 之后焦点仍应在面板内`).toBe(true);
    }
  });

  test('Modal：ESC 关闭后滚动解锁、焦点归还触发按钮', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const opener = page.locator('[data-variant="open-modal"]');
    await opener.click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');

    // 退场动画播完才从 DOM 移除（延迟卸载）；若有人把 transition 删掉，
    // 这条会等到兜底计时器才过——是"慢"而不是"错"，但至少不会永久留着。
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');

    // 焦点必须回到打开它的按钮上，否则键盘用户要从头 Tab 一遍
    await expect(opener).toBeFocused();
  });

  test('Modal：点遮罩关闭，点面板内部不关闭', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);
    await page.locator('[data-variant="open-modal"]').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.click();
    await expect(dialog).toBeVisible();

    // 点遮罩的左上角（面板居中，那里一定是遮罩本身）
    await page.locator('[data-overlay-scrim]').click({ position: { x: 8, y: 8 } });
    await expect(dialog).toHaveCount(0);
  });

  test('ConfirmDialog：alertdialog 语义 + 描述关联 + 初始焦点在「取消」', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);
    await page.locator('[data-variant="open-confirm"]').click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName('删除这个任务？');

    // 描述经 aria-describedby 关联：读屏用户打开时能直接听到后果，
    // 而不是只知道"有个对话框"
    await expect(dialog).toHaveAccessibleDescription('删除后无法恢复，关联的目标进度会同步回退。');

    // §4.5：危险操作的初始焦点落在「取消」。用户随手按回车时，
    // 焦点若在「删除」上就等于一键删除。
    await expect(page.getByRole('button', { name: '取消' })).toBeFocused();

    // ESC 语义等同取消
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('嵌套浮层：一次 ESC 只关最内层', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);
    await page.locator('[data-variant="open-modal"]').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.locator('[data-variant="open-nested-confirm"]').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    // 外层必须还在：这是「每层都无条件响应 ESC 就会两层一起关」的回归守卫。
    // 判据是「焦点在谁里面就关谁」——焦点陷阱保证焦点总在最内层。
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});

test.describe('批次 3b：Drawer / Toast 的抽屉与全局提示', () => {
  test('Drawer：贴右边缘，桌面 440px / 窄屏全屏', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);
    await page.locator('[data-variant="open-drawer"]').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName('编辑任务');

    // 遮罩必须走 edge 落点：这是 Drawer 与 Modal 唯一的形态分叉
    await expect(page.locator('[data-overlay-scrim]')).toHaveAttribute('data-layout', 'edge');

    // 用遮罩作为基准，而不是 `document.documentElement.clientWidth`：面板的容器
    // 就是遮罩，「铺满容器 + 贴住右缘」才是真正的契约。两者在同一次求值里取，
    // 同一坐标系，不受移动端设备像素比（Pixel 5 是 2.75）取整差的影响。
    const readGeometry = async () =>
      page.evaluate(() => {
        const panel = document.querySelector('[role="dialog"]');
        const scrim = document.querySelector('[data-overlay-scrim]');
        if (panel === null || scrim === null) {
          return null;
        }
        const p = panel.getBoundingClientRect();
        const s = scrim.getBoundingClientRect();
        return {
          panelRight: p.right,
          panelWidth: p.width,
          scrimRight: s.right,
          scrimWidth: s.width,
          clientWidth: document.documentElement.clientWidth,
        };
      });

    // 进场是 200ms 的 translateX 位移。不等它播完就量，拿到的是**中间态**
    // （实测差 130px，看起来像"压根没贴边"）。轮询到它停在最终位置再断言。
    await expect
      .poll(
        async () => {
          const geometry = await readGeometry();
          return geometry === null
            ? Number.MAX_SAFE_INTEGER
            : Math.abs(geometry.panelRight - geometry.scrimRight);
        },
        { message: '抽屉应停在遮罩（即视口）的右边缘' },
      )
      .toBeLessThanOrEqual(1);

    const geometry = await readGeometry();
    expect(geometry).not.toBeNull();

    if (geometry !== null) {
      // 供排查：移动端模拟下 `getBoundingClientRect` 与 `clientWidth` 目前差 2px
      // （393 vs 395），需要真机目视确认是否存在横向溢出。
      console.log('[drawer-geometry]', JSON.stringify(geometry));

      // §4.5：桌面 min(440px, 100vw)；≤767px 全屏（铺满遮罩宽度）
      if (geometry.clientWidth > 767) {
        expect(Math.round(geometry.panelWidth)).toBe(440);
      } else {
        expect(Math.abs(geometry.panelWidth - geometry.scrimWidth)).toBeLessThanOrEqual(1);
      }
    }
  });

  test('Drawer：Header 与 Footer 不滚，Body 是唯一滚动区', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);
    await page.locator('[data-variant="open-drawer"]').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // 面板自身不出现滚动条。滚动若发生在最外层，Header 与 Footer 会跟着一起被滚走，
    // 而 Footer 里正是「保存」——长表单填完还得滚回去找它。
    expect(await dialog.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);

    const body = dialog.locator('[data-drawer-body]');
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    const header = dialog.locator('header');
    const footer = dialog.locator('footer');
    const headerBeforeY = (await header.boundingBox())?.y ?? -1;
    const footerBeforeY = (await footer.boundingBox())?.y ?? -1;

    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    const headerAfterY = (await header.boundingBox())?.y ?? -1;
    const footerAfterY = (await footer.boundingBox())?.y ?? -1;

    // 先确认真的取到了几何值，否则下面的相等断言会因「两边都是 -1」而假通过
    expect(headerBeforeY).toBeGreaterThanOrEqual(0);
    expect(footerBeforeY).toBeGreaterThanOrEqual(0);
    expect(headerAfterY).toBe(headerBeforeY);
    expect(footerAfterY).toBe(footerBeforeY);
  });

  test('Drawer：ESC 关闭后焦点归还触发按钮', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const opener = page.locator('[data-variant="open-drawer"]');
    await opener.click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('Toast：错误提示浮在已打开的抽屉之上', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);
    await page.locator('[data-variant="open-drawer"]').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.locator('[data-variant="toast-inside-drawer"]').click();
    await expect(page.locator('[data-toast-id]')).toBeVisible();

    // 用命中测试而不是读 z-index 的数字：真正浮在最上层意味着在提示条所在的
    // 坐标上取到的元素属于它。层级写错的症状正是「提示被浮层盖住」，而那种
    // 情况下 z-index 的值仍然是对的。
    const toastOnTop = await page.evaluate(() => {
      const element = document.querySelector('[data-toast-id]');
      if (element === null) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit !== null && element.contains(hit);
    });
    expect(toastOnTop).toBe(true);
  });

  test('Toast：最多 3 条、新条在最下方、底部居中', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);
    await page.locator('[data-variant="toast-overflow"]').click();

    const items = page.locator('[data-toast-id]');
    await expect(items).toHaveCount(3);

    // 普通态是 status；错误态才是 alert（那条在下面的用例里断言）
    await expect(items.nth(0)).toHaveAttribute('role', 'status');

    // 连发 4 条，第 1 条被淘汰（最老的自动关闭条），留下的是第 2~4 条
    await expect(items.nth(0)).toContainText('第二条');
    await expect(items.nth(2)).toContainText('第四条');

    const first = await items.nth(0).boundingBox();
    const last = await items.nth(2).boundingBox();
    const layoutWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(first).not.toBeNull();
    expect(last).not.toBeNull();

    if (first !== null && last !== null) {
      // 新条在最底部、旧条向上顶
      expect(last.y).toBeGreaterThan(first.y);

      // 堆叠列水平居中于视口
      expect(Math.abs(first.x + first.width / 2 - layoutWidth / 2)).toBeLessThanOrEqual(2);
    }
  });

  test('Toast：普通提示 5 秒后自动消失', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);
    await page.locator('[data-variant="toast-plain"]').click();
    await expect(page.locator('[data-toast-id]')).toBeVisible();

    // 5 秒自动关闭 + 退场 + 移除。上限放宽到 9 秒，避免受构建机负载影响。
    await expect(page.locator('[data-toast-id]')).toHaveCount(0, { timeout: 9000 });
  });

  test('Toast：错误态常驻不自动关闭，但要留手动出口', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);
    await page.locator('[data-variant="toast-error"]').click();

    // 不能用 `getByRole('alert')`：这一页上还有三个表单错误提示与 Next 的
    // RouteAnnouncer 也都是 alert，会直接撞上 strict mode violation。
    // 用 data 属性定位，同时把 role 本身断言掉（语义仍要守住）。
    const alert = page.locator('[data-toast-id]');
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toContainText('同步失败，请重试');

    // NFR-REL-002：失败必须明确提示，所以它不参与自动关闭。
    // 等过普通提示的 5 秒档，它仍应留在页面上。
    await page.waitForTimeout(6000);
    await expect(alert).toBeVisible();

    // 「常驻」不等于关不掉：手动出口必须在
    await alert.getByRole('button', { name: '关闭提示' }).click();
    await expect(page.locator('[data-toast-id]')).toHaveCount(0);
  });

  test('Toast：悬停时暂停计时', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);
    await page.locator('[data-variant="toast-plain"]').click();

    const toast = page.locator('[data-toast-id]');
    await expect(toast).toBeVisible();
    await toast.hover();

    // 指针停在上面时不关闭：否则用户正要点「撤销」，提示先自己消失了
    await page.waitForTimeout(6000);
    await expect(toast).toBeVisible();
  });

  test('Toast：操作槽可用且点击后关掉这条', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);
    await page.locator('[data-variant="toast-with-action"]').click();

    const toast = page.locator('[data-toast-id]');
    await expect(toast).toContainText('任务已归档');

    // 操作由调用方提供（§4.5：组件只给槽位，不内置撤销业务逻辑）
    await toast.getByRole('button', { name: '撤销' }).click();
    await expect(page.locator('[data-toast-id]')).toHaveCount(0);
  });
});

test.describe('批次 4：页面状态组件（EmptyState / LoadingState / ErrorState）', () => {
  test('EmptyState：虚线框、令牌圆角、不加图标', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const root = page.locator('[data-variant="state-empty"] > div');
    await expect(root).toBeVisible();

    const style = await root.evaluate((el) => {
      const computed = getComputedStyle(el);
      return {
        borderStyle: computed.borderTopStyle,
        borderWidth: computed.borderTopWidth,
        borderRadius: computed.borderTopLeftRadius,
        borderColor: computed.borderTopColor,
      };
    });

    // 原型 `.empty-state` 的虚线框——§4.6 明确这是空态专属语言
    expect(style.borderStyle).toBe('dashed');
    expect(style.borderWidth).toBe('1px');
    // --radius-md = 14px（原型 16px 就近归整，不新增圆角档）
    expect(style.borderRadius).toBe('14px');
    // --color-border = #e5e5e2
    expect(style.borderColor).toBe('rgb(229, 229, 226)');

    // 不加图标：原型无此形态，§4.6 明确不预造
    await expect(root.locator('svg')).toHaveCount(0);
  });

  test('EmptyState：两个操作槽都可省', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const plain = page.locator('[data-variant="state-empty-plain"] > div');
    await expect(plain).toContainText('暂无开销记录');
    await expect(plain).toContainText('记一笔之后');
    // 只给两段文字也能成立——空态的「具体下一步」也可以由文案承担
    await expect(plain.getByRole('button')).toHaveCount(0);

    // 对照：给了槽的那一格渲染出的是调用方传的真实 Button
    const withSlots = page.locator('[data-variant="state-empty"] > div');
    await expect(withSlots.locator('[data-variant="empty-primary"]')).toBeVisible();
    await expect(withSlots.locator('[data-variant="empty-secondary"]')).toBeVisible();
  });

  test('LoadingState：role 与 aria-busy 到位，骨架底色正确且零循环动画', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const status = page.locator('[data-variant="state-loading"] [role="status"]');
    await expect(status).toHaveAttribute('aria-busy', 'true');

    // 骨架数量与调用方给的一致
    const skeletons = status.locator('span[aria-hidden="true"]');
    await expect(skeletons).toHaveCount(3);

    const style = await skeletons.first().evaluate((el) => {
      const computed = getComputedStyle(el);
      return {
        background: computed.backgroundColor,
        borderRadius: computed.borderTopLeftRadius,
        animationName: computed.animationName,
      };
    });

    // --color-surface-soft = #f0f0ed
    expect(style.background).toBe('rgb(240, 240, 237)');
    // --radius-sm = 10px
    expect(style.borderRadius).toBe('10px');
    // §4.6：静态骨架，不转圈、不 shimmer、不呼吸
    expect(style.animationName).toBe('none');
  });

  test('ErrorState：alert 语义、图标是唯一红色、无衬底边框', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const root = page.locator('[data-variant="state-error"] [role="alert"]');
    await expect(root).toBeVisible();

    const style = await root.evaluate((el) => {
      const computed = getComputedStyle(el);
      const icon = el.querySelector('svg');
      const title = el.querySelector('p');
      return {
        borderStyle: computed.borderTopStyle,
        iconColor: icon === null ? null : getComputedStyle(icon).color,
        titleColor: title === null ? null : getComputedStyle(title).color,
      };
    });

    // 虚线框是空态专属，错误态没有衬底边框
    expect(style.borderStyle).toBe('none');
    // --color-danger = #c0392b
    expect(style.iconColor).toBe('rgb(192, 57, 43)');
    // 标题保持 text-primary：不做整面红，也不稀释 danger 在删除场景的分量
    expect(style.titleColor).toBe('rgb(29, 29, 31)');
  });

  test('ErrorState：重试是近黑主按钮（肯定动作，不是危险动作）', async ({ page }) => {
    await page.goto(STYLEGUIDE_PATH);

    const retry = page.locator('[data-variant="error-retry"]');
    await expect(retry).toBeVisible();
    await expect(retry).toHaveText('重试');

    // --color-primary-surface = #1d1d1f
    const background = await retry.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).toBe('rgb(29, 29, 31)');
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
