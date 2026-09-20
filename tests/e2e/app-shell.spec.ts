/**
 * 应用外壳端到端测试（UI-003）。
 *
 * 这一层验的是**真实浏览器里的几何与行为**：三档列宽、`::first-letter`
 * 折叠是否真的生效、横向溢出、真实路由切换后的当前页标记与文档标题。
 *
 * 与 `tests/integration/ui/AppShell.test.tsx` 的分工：那一层测结构与 ARIA，
 * 这一层测只有布局引擎才能回答的问题——jsdom 不做布局、媒体查询也不生效。
 *
 * 三档形态各自显式设置视口（而不是依赖 project 的默认尺寸），
 * 这样同一份断言在桌面/移动两个 project 下都会跑一遍，且结果确定。
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const SIDEBAR = '[data-app-sidebar]';
const PAGE = '[data-app-page]';
const NAV_TOGGLE = '[data-nav-toggle]';
const DRAWER = '#app-nav-drawer';
const SCRIM = '[data-overlay-scrim="true"]';

/** 面板是 `position: fixed` 元素，它的包含块宽与 `clientWidth` 可能差 1–2px，
 *  所以凡是"贴边"类断言都取回来自己算，不拿不同源的基准去比。 */
async function layoutWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.clientWidth);
}

test.describe('外壳 · 桌面（≥1024px）', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('侧栏展开可见，宽度是 232px', async ({ page }) => {
    await page.goto('/today');

    const sidebar = page.locator(SIDEBAR);
    await expect(sidebar).toBeVisible();

    expect(Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(232);
    // 平板折叠档特有的文字隐藏在这里不该出现：导航文字是正常可见的。
    const fontSize = await sidebar
      .locator('nav a')
      .first()
      .evaluate((element) => getComputedStyle(element).fontSize);
    expect(fontSize).not.toBe('0px');
  });

  test('宽视口下页面区封顶 1200px 并居中', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/today');

    // 移动端模拟（`isMobile: true`）下改视口会令移动视口元信息重新生效并触发
    // 一次重排，元素在那一瞬可能还没有盒子——`boundingBox()` 会返回 `null`，
    // 经 `?? 0` 静默变成 0，看起来像"页面区宽度是 0"。先等它可见再量。
    await expect(page.locator(PAGE)).toBeVisible();

    const box = await page.locator(PAGE).boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(1200);

    // 居中：左右留白相等（各自的取整误差不超过 1px）。
    const viewport = await layoutWidth(page);
    const sidebarWidth = Math.round((await page.locator(SIDEBAR).boundingBox())?.width ?? 0);
    const leftGap = Math.round(box?.x ?? 0) - sidebarWidth;
    const rightGap = viewport - Math.round((box?.x ?? 0) + (box?.width ?? 0));

    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
  });

  test('导航切换后当前页标记与文档标题同步', async ({ page }) => {
    await page.goto('/today');

    await expect(page.getByRole('link', { name: '今日' })).toHaveAttribute('aria-current', 'page');

    await page.getByRole('link', { name: '复盘' }).click();

    await expect(page).toHaveURL(/\/review$/);
    await expect(page.getByRole('link', { name: '复盘' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('link', { name: '今日' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
    // 文档标题走根布局的模板：页面只写短标题，产品名由模板拼上。
    await expect(page).toHaveTitle(/复盘/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('复盘');
  });

  test('导航项可由键盘聚焦并显示焦点环', async ({ page }) => {
    await page.goto('/today');

    const link = page.getByRole('link', { name: '收件箱' });

    // 先按一次 Tab 把输入模态切到键盘，`:focus-visible` 才会匹配——
    // 否则程序化聚焦在 Chromium 里可能不触发焦点环。
    await page.keyboard.press('Tab');
    await link.focus();

    const outline = await link.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });

    expect(outline.style).not.toBe('none');
    expect(Number.parseFloat(outline.width)).toBeGreaterThan(0);
  });
});

test.describe('外壳 · 平板（768–1023px）', () => {
  test.use({ viewport: { width: 900, height: 800 } });

  test('侧栏折叠为 72px 单栏：文字隐去、首字保留、可访问名称完整', async ({ page }) => {
    await page.goto('/today');

    const sidebar = page.locator(SIDEBAR);
    await expect(sidebar).toBeVisible();

    expect(Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(72);

    const item = sidebar.locator('nav a').first();

    // 「隐去」而不是「删除」：字号被压到 0，说明文字仍在 DOM 里
    // （若换成 display:none，下面的可访问名称断言会失败）。
    expect(await item.evaluate((element) => getComputedStyle(element).fontSize)).toBe('0px');

    // 首字被单独放回正文字号——这是"折叠档真的显示出了字"的唯一证据。
    expect(
      await item.evaluate((element) => getComputedStyle(element, '::first-letter').fontSize),
    ).toBe('16px');

    // 读屏拿到的仍是完整名称，而不是被裁掉的单字。
    await expect(item).toHaveAccessibleName('今日');

    // 汉堡属于手机档，平板上不该出现。
    await expect(page.locator(NAV_TOGGLE)).toBeHidden();
  });
});

test.describe('外壳 · 手机（≤767px）', () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test('流式侧栏让位给抽屉：侧栏隐藏、汉堡出现', async ({ page }) => {
    await page.goto('/today');

    // 侧栏是 `display: none`——不是"移到屏幕外还留着"，
    // 所以它同时也不在无障碍树里、无法被 Tab 聚焦。
    await expect(page.locator(SIDEBAR)).toBeHidden();
    await expect(page.locator(NAV_TOGGLE)).toBeVisible();
  });

  test('汉堡唤出 250px 左抽屉，点遮罩可关闭', async ({ page }) => {
    await page.goto('/today');

    const toggle = page.locator(NAV_TOGGLE);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();

    const drawer = page.locator(DRAWER);
    await expect(drawer).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // 进场是 200ms 的位移。不等它播完就量，拿到的是**中间态**——
    // 实测面板还停在 `translateX(-73.6px)`，看起来像"没贴边"。
    // 所以先轮询到位移结束，再断言最终几何量。
    await expect
      .poll(
        async () => {
          const box = await drawer.boundingBox();
          return box === null ? Number.MAX_SAFE_INTEGER : Math.abs(box.x);
        },
        { message: '抽屉应停在视口左边缘' },
      )
      .toBeLessThanOrEqual(1);

    const settled = await drawer.boundingBox();
    const viewport = await layoutWidth(page);

    expect(Math.round(settled?.width ?? 0)).toBe(250);
    // 抽屉不该比视口还宽（窄屏上 250px 是"最多"）
    expect(Math.round(settled?.width ?? 0)).toBeLessThanOrEqual(viewport);

    // 点遮罩（靠右的位置，避开 250px 宽的抽屉）关闭。
    await page.mouse.click(360, 400);
    await expect(drawer).toBeHidden();
  });

  test('点抽屉里的导航链接：路由切换且抽屉自动关闭', async ({ page }) => {
    await page.goto('/today');

    const toggle = page.locator(NAV_TOGGLE);
    await toggle.click();

    const drawer = page.locator(DRAWER);
    await expect(drawer).toBeVisible();

    // 这条守的是一个真实缺陷：抽屉是**浮层**，路由切换**不会**自动关掉它。
    // 链接必须经 `onNavigate` → `onClose` 显式关闭，否则新页面被抽屉与遮罩
    // 盖着、滚动还锁着，用户得再按一次 ESC 才看得到自己刚点的页面。
    await drawer.getByRole('link', { name: '收件箱' }).click();

    await expect(page).toHaveURL(/\/inbox$/);
    await expect(drawer).toBeHidden();
    await expect(page.locator(SCRIM)).toHaveCount(0);

    // 滚动锁也要真的解开，否则"抽屉关了"只是视觉上的。
    await expect
      .poll(async () => page.evaluate(() => document.body.style.overflow))
      .not.toBe('hidden');

    // 汉堡的展开态是同一个状态的另一个投影，必须同步复位。
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('抽屉里的品牌链接同样会关闭抽屉（同一缺陷的另一条入口）', async ({ page }) => {
    await page.goto('/review');

    await page.locator(NAV_TOGGLE).click();

    const drawer = page.locator(DRAWER);
    await expect(drawer).toBeVisible();

    await drawer.getByRole('link', { name: 'Livefil' }).click();

    await expect(page).toHaveURL(/\/today$/);
    await expect(drawer).toBeHidden();
  });

  test('ESC 关闭抽屉', async ({ page }) => {
    await page.goto('/today');

    await page.locator(NAV_TOGGLE).click();
    await expect(page.locator(DRAWER)).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.locator(DRAWER)).toBeHidden();
    await expect(page.locator(SCRIM)).toHaveCount(0);
  });
});

test.describe('外壳 · 响应式边界', () => {
  test('四档视口都不产生横向溢出', async ({ page }) => {
    for (const width of [1600, 1280, 900, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/today');

      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));

      expect(metrics.scrollWidth, `${String(width)}px 视口下不应出现横向滚动`).toBeLessThanOrEqual(
        metrics.clientWidth + 1,
      );
    }
  });
});
