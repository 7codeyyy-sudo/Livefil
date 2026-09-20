/**
 * 设计令牌的浏览器端验证（UI-001）。
 *
 * 与 `tests/unit/shared/ui/tokens.test.ts` 的分工：
 * - 单测在**源文件**上判定「取值是否与《UI 页面规范》§2.4 逐项一致」；
 * - 本文件在**真实浏览器**里判定「令牌是否真的生效」——也就是 CSS 到底有没有
 *   被加载、断点覆盖有没有起作用。
 *
 * 为什么这层不可省：一个令牌文件写对了、单测全绿，但根布局忘了导入，
 * 系统里没有任何样式——「文件正确」与「约束成立」是两件事。
 *
 * 本文件在 `desktop-chromium` 与 `mobile-chromium` 两个 project 下各跑一次，
 * 因此响应式断言写的是「随视口变化的期望」，而不是某个固定值。
 */
import { expect, test, type Page } from '@playwright/test';

import { stubTaskQueryAsEmpty } from './support/api-stub';

/** 读取 `:root` 上的自定义属性（浏览器返回的是声明值，未做数值解析）。 */
async function readToken(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (tokenName) => getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim(),
    name,
  );
}

/**
 * 把颜色归一成语义等价形式。
 *
 * 生产构建会压缩颜色（实测 `#ffffff` → `#fff`），所以浏览器里读到的位数
 * 可能与源文件不同。**比较语义，不比较字面量。**
 */
function normalizeColor(value: string): string {
  const lowered = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(lowered);
  const digits = hex?.[1];

  if (digits === undefined) {
    return lowered.replace(/\s+/g, '');
  }

  return digits.length === 3
    ? `#${digits
        .split('')
        .map((character) => `${character}${character}`)
        .join('')}`
    : `#${digits}`;
}

test('根布局已加载设计令牌：关键变量在真实浏览器中可读', async ({ page }) => {
  await page.goto('/');

  // 若根布局漏了导入，这些变量会返回空字符串——本用例正是为此存在。
  const samples = [
    ['--color-bg-page', '#f7f7f5'],
    ['--color-surface', '#ffffff'],
    ['--color-text-primary', '#1d1d1f'],
    ['--color-accent', '#1769e0'],
    ['--color-danger', '#c0392b'],
  ] as const;

  for (const [name, expected] of samples) {
    const actual = await readToken(page, name);
    expect(actual, `${name} 应已定义（非空）`).not.toBe('');
    expect(normalizeColor(actual), `${name} 取值应与规范一致`).toBe(normalizeColor(expected));
  }
});

test('派生令牌与阴影令牌同样生效', async ({ page }) => {
  await page.goto('/');

  expect(normalizeColor(await readToken(page, '--color-accent-soft'))).toBe(
    normalizeColor('#eaf1ff'),
  );
  expect(await readToken(page, '--shadow-raised')).not.toBe('');
  expect(await readToken(page, '--radius-md')).toBe('14px');
});

test('第一阶段是浅色：color-scheme 为 light', async ({ page }) => {
  await page.goto('/');

  const colorScheme = await page.evaluate(
    () => getComputedStyle(document.documentElement).colorScheme,
  );

  expect(colorScheme).toBe('light');
});

test('深色未激活：html 上没有 data-theme 属性', async ({ page }) => {
  await page.goto('/');

  // 深色只预留不实现。若这里读到值，说明有人绕过开关把未验收的深色交付了。
  const themeAttribute = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );

  expect(themeAttribute).toBeNull();
});

test('页面内边距随视口收敛（断点覆盖真实生效）', async ({ page }) => {
  await page.goto('/');

  const width = page.viewportSize()?.width ?? 0;
  const expected = width <= 767 ? '16px' : width <= 1023 ? '24px' : '32px';

  expect(await readToken(page, '--space-page-x'), `视口宽 ${String(width)}px`).toBe(expected);
});

test('令牌生效的同时没有引入控制台错误', async ({ page }) => {
  // 从 UI-004 起首页会按 §4.7 用真实端点取数，而本批没有业务端点——
  // 不接住那条请求，浏览器会记一条 resource error，掩盖掉这条用例真正
  // 要找的东西（样式解析或脚本错误）。
  await stubTaskQueryAsEmpty(page);

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // 样式加载失败（例如 CSS 解析错误）通常会在控制台留下痕迹。
  expect(consoleErrors).toEqual([]);
});
