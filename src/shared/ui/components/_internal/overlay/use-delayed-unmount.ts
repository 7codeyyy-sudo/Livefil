'use client';

import { useCallback, useEffect, useState } from 'react';
import type { TransitionEvent } from 'react';

/** 浮层的两种呈现阶段，直接映射到 `data-state` 供 CSS 驱动动画。 */
export type OverlayPhase = 'open' | 'closed';

export type DelayedUnmount = {
  /** 是否应该留在 DOM 里。退场动画播完之前保持 true。 */
  readonly mounted: boolean;
  readonly phase: OverlayPhase;
  /** 挂到面板上；只在面板自身的过渡结束时才推进卸载。 */
  readonly onTransitionEnd: (event: TransitionEvent<HTMLElement>) => void;
};

/**
 * 兜底卸载上限（毫秒）。
 *
 * 取得比最长的 `--duration-slow`（250ms）大得多：它的作用不是"等动画"，
 * 而是防止**面板根本没有可过渡属性**（有人把 CSS 里的退场过渡删了）时，
 * 元素永远留在 DOM 里、遮罩关不掉。那种情况下 1 秒后强制卸载，
 * 虽然失去了动画，但功能不会卡死。
 */
const FALLBACK_UNMOUNT_MS = 1000;

/**
 * 进退场延迟卸载（浮层内部基建，批次 3a）。
 *
 * 浮层关闭时**不能立刻从 DOM 摘掉**，否则退场动画根本没有机会播放。
 *
 * ## 进场与退场用两套机制，这是刻意的
 *
 * - **进场靠 CSS 动画**：元素挂载那一刻就该播放。若用过渡，元素一挂载就已经是
 *   终态（`data-state="open"`），浏览器没有起始值可插值，过渡根本不会发生。
 * - **退场靠过渡**：`data-state` 从 open 变成 closed 时自动插值，
 *   结束后派发 `transitionend`，由它驱动真正的卸载。
 *
 * ## 为什么用 `transitionend` 而不是 `setTimeout(250)`
 *
 * 1. **不需要在 JS 里复述时长**。`prefers-reduced-motion` 下 tokens.css 会把
 *    时长压到 `0.01ms`，`transitionend` 照样触发；如果 JS 里写死 250ms，
 *    减少动效的用户每次关闭都要白等 0.25 秒。（当初把 reduced-motion 的值设成
 *    `0.01ms` 而不是 `0` 就是为了保住这个事件——`0` 会让过渡直接不触发。）
 * 2. 将来调时长只改 tokens.css 一处，组件与 JS 零改动。
 *
 * ## 两个 setState 都在异步回调里
 *
 * `setMounted(true)` 放在 `requestAnimationFrame` 里、兜底放在 `setTimeout` 里，
 * 而不是直接在 effect 主体同步调用。React 的 `set-state-in-effect` 规则拦的正是
 * 后者（同步调用会触发级联渲染）；放进帧回调既满足规则，也恰好是「先挂载、
 * 下一帧再让动画跑」这个时序所需要的。
 */
export function useDelayedUnmount(open: boolean): DelayedUnmount {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    // 下一帧才挂载：让进场的 CSS 动画有「从无到有」这个起点。
    const frame = requestAnimationFrame(() => {
      setMounted(true);
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [open]);

  useEffect(() => {
    if (open || !mounted) {
      return undefined;
    }

    const timer = setTimeout(() => {
      setMounted(false);
    }, FALLBACK_UNMOUNT_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [open, mounted]);

  const onTransitionEnd = useCallback(
    (event: TransitionEvent<HTMLElement>) => {
      // 只认面板**自身**的过渡结束。子元素（比如里面的按钮 hover、
      // 进度条宽度变化）的过渡会冒泡上来，不拦住就会提前把浮层卸掉。
      if (event.target !== event.currentTarget || open) {
        return;
      }
      setMounted(false);
    },
    [open],
  );

  return {
    mounted,
    // 阶段从 `open` 直接派生，不另立 state：两个真相来源必然不同步。
    phase: open ? 'open' : 'closed',
    onTransitionEnd,
  };
}
