'use client';

import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * 可聚焦元素的候选选择器（浮层内部基建，批次 3a）。
 *
 * 与 WAI-ARIA 作者实践指南给出的清单一致。刻意**不做可见性过滤**——
 * 常见写法会用 `offsetParent !== null` 或 `getClientRects().length > 0` 剔除
 * 隐藏元素，但那两个判据在 jsdom（没有布局引擎）下会把**所有**元素判定为隐藏，
 * 于是焦点陷阱在测试里永远拿不到候选，等于把这块逻辑推进了不可测的盲区。
 * 浮层内部放隐藏按钮本来就少见，不值得用可测性去换。
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * 焦点陷阱（浮层内部基建，批次 3a）。
 *
 * 三件事，缺一不可（§4.5 明文要求）：
 * 1. **初始焦点进入面板**——否则键盘用户仍然停在背景页面里，Tab 会跑到浮层外；
 * 2. **Tab 在面板内首尾循环**——不做的话焦点会溜到背景，浮层形同虚设；
 * 3. **关闭后焦点归还触发元素**——否则焦点掉回 `<body>`，键盘用户要从头再 Tab 一遍。
 *
 * @param containerRef 浮层容器（面板本身），必须能被聚焦（`tabIndex={-1}`）。
 * @param active 浮层是否处于打开态。
 * @param initialFocusSelector 初始焦点的**选择器**（相对容器），不给则聚焦容器本身。
 *   用选择器而不是 `RefObject` 是刻意的：确认弹窗要把焦点放到「取消」按钮上，
 *   而那个按钮是 `Button` 组件的产物、拿不到 DOM ref——为一个用法去给批次 1 的
 *   `Button` 加 `ref` 透传，改动面比收益大。选择器还顺带让"焦点应该落在哪"
 *   这件事在调用处一眼可读。
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  initialFocusSelector?: string | undefined,
): void {
  useEffect(() => {
    if (!active) {
      return;
    }

    const container = containerRef.current;
    if (container === null) {
      return;
    }

    // 记录触发元素——在移动焦点**之前**取，否则拿到的就是浮层内部元素了。
    const returnFocusTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const matched =
      initialFocusSelector === undefined
        ? null
        : container.querySelector<HTMLElement>(initialFocusSelector);
    // 选择器没匹配到就退回容器本身，而不是让焦点留在背景页面上——
    // 「焦点没进浮层」比「焦点没落在预期位置」严重得多。
    (matched ?? container).focus();

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Tab' || container === null) {
        return;
      }

      const focusables = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      const first = focusables.at(0);
      const last = focusables.at(-1);

      // 面板里一个可聚焦元素都没有时，把焦点摁在容器上，别让它跑出去。
      if (first === undefined || last === undefined) {
        event.preventDefault();
        container.focus();
        return;
      }

      const current = document.activeElement;
      const insideContainer = current instanceof HTMLElement && container.contains(current);

      if (event.shiftKey) {
        if (!insideContainer || current === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!insideContainer || current === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // 元素可能已经从 DOM 里摘掉了（React 卸载顺序），focus 到已脱离文档的
      // 节点不会生效也不会报错——这里只是尽力归还。
      returnFocusTo?.focus();
    };
  }, [active, containerRef, initialFocusSelector]);
}
