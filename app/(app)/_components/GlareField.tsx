'use client';

import { useEffect } from 'react';

/**
 * 悬停眩光的全局指针委托（UI-011 §6.1）。
 *
 * ## 为什么是 document 级委托，而不是每个元素各自监听
 *
 * 眩光要挂的元素不止一处（primary 按钮、建议 chips、区块行……），逐个
 * `addEventListener` 意味着每处都要管挂载/卸载，漏一处就是泄漏。委托只挂
 * 一次：指针移动时找 `closest('[data-glare]')`，命中就把相对坐标写进该元素的
 * `--gx/--gy`（百分比，CSS 端 `radial-gradient at var(--gx) var(--gy)` 直接消费）。
 * 元素是否需要眩光由它自己带不带 `data-glare` 决定——样式与解耦都在各自一侧。
 *
 * ## 为什么不用 requestAnimationFrame 节流
 *
 * 写入只是两个自定义属性（不触发重排的样式变更），且 `pointermove` 在现代
 * 浏览器里本身按帧对齐；引入 rAF 反而要处理回调时机与卸载清理两件事。
 * 参考站口径同样是「直接写，不节流」。
 *
 * 组件不渲染任何 DOM（返回 null），只在挂载期间维持这一个监听器。
 */
export function GlareField() {
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const carrier = (event.target as Element | null)?.closest<HTMLElement>('[data-glare]');
      if (carrier == null) {
        return;
      }

      const rect = carrier.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }

      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      carrier.style.setProperty('--gx', `${x.toFixed(2)}%`);
      carrier.style.setProperty('--gy', `${y.toFixed(2)}%`);
    };

    document.addEventListener('pointermove', handlePointerMove, { passive: true });
    return () => document.removeEventListener('pointermove', handlePointerMove);
  }, []);

  return null;
}
