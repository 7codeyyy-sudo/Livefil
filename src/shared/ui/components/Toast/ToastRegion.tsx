'use client';

import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

import styles from './ToastRegion.module.css';

export type ToastRegionProps = {
  readonly children: ReactNode;
};

/**
 * 提示条的挂载容器（UI-002 批次 3b）。
 *
 * ## 为什么不复用 `OverlayPortal`
 *
 * 那个容器的语义是**遮罩**——半透明底、点击关闭、把面板居中。提示条一个都不要：
 * 它不遮任何东西、点它不该关什么、落点在底部而不是中央。两者真正共享的只有
 * 「挂到 body」这一个事实，而为了共用那一行 `createPortal` 去给 `OverlayPortal`
 * 加一个「不要遮罩」的开关，等于让两个组件都变成带分支的万能容器。
 *
 * ## 为什么必须挂到 body
 *
 * 提示条是「全局通道」：无论它从哪个页面、哪一层组件里被唤起，都要浮在
 * 浮层之上（`--z-toast` > `--z-overlay`）。留在原地就会被祖先的
 * `overflow: hidden` / `transform` 裁掉或改变定位基准。
 */
export function ToastRegion({ children }: ToastRegionProps) {
  // 服务端没有 `document`，无处可挂。直接判而不是 `useEffect + setState`：
  // 后者是在 effect 里同步 setState（级联渲染），React 的规则会直接报错。
  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className={styles.region} data-toast-region="true">
      {children}
    </div>,
    document.body,
  );
}
