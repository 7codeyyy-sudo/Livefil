'use client';

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * ESC 关闭浮层（浮层内部基建，批次 3a）。
 *
 * ## 为什么只在「焦点位于本浮层内」时才响应
 *
 * 嵌套浮层是常态：Modal 里再开一个确认弹窗。如果每层都无条件响应 ESC，
 * 一次按键会把**两层一起关掉**——用户以为只取消了确认，回头发现连表单也关了。
 * `stopPropagation` 在这里救不了场：同一个 `document` 上的多个监听器是
 * 依次执行的，前者无法阻止后者（只有 `stopImmediatePropagation` 能，而那依赖
 * 注册顺序这种脆弱前提）。
 *
 * 「焦点在谁里面就关谁」则天然正确，而且它恰好是用户的心智模型：
 * 焦点陷阱保证了内层浮层持有焦点，所以 ESC 总是作用于最内层。
 *
 * ## 回调用 ref 保存
 *
 * 这样调用方即使传内联箭头函数，也不会导致监听器每次渲染都重新注册——
 * 把「必须 useCallback」这种隐性契约从调用方身上拿掉。
 */
export function useEscapeKey(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape: () => void,
): void {
  const handlerRef = useRef(onEscape);

  useEffect(() => {
    handlerRef.current = onEscape;
  });

  useEffect(() => {
    if (!active) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') {
        return;
      }

      const container = containerRef.current;
      if (container !== null && !container.contains(document.activeElement)) {
        return;
      }

      handlerRef.current();
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [active, containerRef]);
}
