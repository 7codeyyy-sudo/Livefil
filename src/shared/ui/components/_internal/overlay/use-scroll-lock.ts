'use client';

import { useEffect } from 'react';

/**
 * 背景滚动锁（浮层内部基建，批次 3a）。
 *
 * 浮层打开时把 `body` 的 overflow 换成 `hidden`，关闭时**恢复成打开前的值**——
 * 不是恢复成空字符串：调用方可能本来就有自己的 overflow 设置，无条件清空会
 * 悄悄改掉别人的样式。
 *
 * ## 多层浮层天然正确
 *
 * 内层浮层打开时记录到的"原值"就是 `hidden`，关闭时写回 `hidden`；外层关闭时
 * 才写回真实原值。React 的 effect 清理函数按**注册的逆序**执行，正好就是
 * 浮层的关闭顺序，因此不需要额外的计数器或栈。
 *
 * ## 已知边界
 *
 * 只处理 `overflow`，不做 iOS 那种 `position: fixed` + 记录 scrollY 的补偿方案。
 * 第一阶段 PC Web 优先，等真的上移动端 PWA 时再评估。
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';

    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [active]);
}
