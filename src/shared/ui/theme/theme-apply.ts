/**
 * 主题的应用与切换（UI-012）。
 *
 * ## 这是 `data-theme` 的**唯一应用函数**
 *
 * 深色激活协议要求主题属性只挂 `<html>` 单一节点。本文件是该属性的运行时
 * 唯一设置点；另一处是根布局的**防闪引导脚本**——它必须在首帧前运行、只能
 * 自包含地内联，无法复用本函数。`tests/e2e/ui-001-acceptance.mjs` 的
 * 「设置点白名单」断言把这两处钉死，任何第三处设置点都会被拦下。
 *
 * ## 切换为什么走 View Transitions
 *
 * 圆形扩散揭示（视觉方案 v2 采纳项）：点「暗色」时从开关位置扩散出新主题。
 * 快照必须是**干脆的终态**，所以切换期间给根元素挂 `.theming` 把普通
 * transition 全部停掉（样式在 `app/globals.css`）。不支持该 API 的浏览器
 * 直接切换——渐进增强、无降级缺陷；`prefers-reduced-motion` 由 tokens.css
 * 的单点归零自动收敛（扩散动画时长引 `--duration-slow` 派生，不写媒体查询）。
 */

import type { Theme } from './theme-storage';

/** 主题属性名（白名单断言按此文本识别设置点）。 */
export const THEME_ATTRIBUTE = 'data-theme';

/** 落主题属性。引导脚本与运行时切换保持同一落点语义，只替换值、引用方零改动。 */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
}

/** `document.startViewTransition` 的最小可用签名（不依赖 lib.dom 的版本差异）。 */
type ViewTransitionStarter = (callback: () => void) => { readonly finished: Promise<void> };

/**
 * 落新主题：有 View Transitions 时从 `origin` 位置向全页圆形扩散，
 * 没有（或恰有过渡在跑）时直接切换。
 *
 * `origin` 传 `null` 时不写扩散原点，CSS 里有 `50% 40%` 的兜底值。
 */
export function applyThemeWithTransition(theme: Theme, origin: Element | null): void {
  const root = document.documentElement;

  if (origin !== null) {
    const rect = origin.getBoundingClientRect();
    root.style.setProperty('--tx', `${String(rect.left + rect.width / 2)}px`);
    root.style.setProperty('--ty', `${String(rect.top + rect.height / 2)}px`);
  }

  const starter = (
    document as Document & {
      startViewTransition?: ViewTransitionStarter;
    }
  ).startViewTransition;

  if (starter === undefined) {
    applyTheme(theme);
    return;
  }

  root.classList.add('theming');

  try {
    const transition = starter.call(document, () => {
      applyTheme(theme);
    });
    void transition.finished.finally(() => {
      root.classList.remove('theming');
    });
  } catch {
    // 已有过渡在跑（例如路由切换）时浏览器会拒绝新过渡：
    // 释放过渡豁免并退回直接切换，主题不会卡在旧值。
    root.classList.remove('theming');
    applyTheme(theme);
  }
}
