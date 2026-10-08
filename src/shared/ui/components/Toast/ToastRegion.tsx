'use client';

import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

import styles from './ToastRegion.module.css';

export type ToastRegionProps = {
  readonly children: ReactNode;
};

/**
 * 订阅「现在能不能挂到 body 上」这个外部事实。
 *
 * 提到模块作用域而不是写在组件里：`useSyncExternalStore` 每次渲染都会比对
 * `subscribe` 的引用，内联函数会让它每次都重新订阅一遍。
 *
 * 这个事实只会从「否」翻到「是」一次，没有可订阅的变更源，因此返回空退订；
 * 水合完成后 React 会自己拿客户端快照与本次渲染比对并重渲染。
 */
function subscribe(): () => void {
  return () => undefined;
}

/** 客户端快照：能挂。 */
function getSnapshot(): boolean {
  return true;
}

/**
 * 服务端与水合首帧的快照：`false`——此刻没有 `document`，提示条无处可挂。
 *
 * 取舍与 `use-online-status.ts` 同源：服务端取不到「用户此刻的真实状态」，
 * 就给一个**与 SSR 产物一致**的值，等水合完成后再切到真实值，
 * 首帧两棵树才不会不同构。
 */
function getServerSnapshot(): boolean {
  return false;
}

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
 *
 * ## 为什么用 `useSyncExternalStore`，而不是渲染期判 `typeof document`
 *
 * 曾经写成「服务端分支渲 `null`、客户端分支渲 `createPortal`」。那是一个
 * **服务端/客户端渲染分支**：SSR 产物与客户端首帧不同构，React 会把整棵子树
 * 判为水合失败并在控制台报错（React 压缩错误码 418），首页、`/today` 等所有路由都命中。
 *
 * `useSyncExternalStore` 自带 SSR 快照入口，把「现在能不能挂」当成一个
 * **外部事实**来读：水合帧取服务端快照（`false`，与 SSR 一致），水合完成后取
 * 客户端快照（`true`，挂上 portal）——这次切换由 React 负责，不再是渲染分支。
 * 同款范式见 `AsyncState/use-online-status.ts`。
 */
export function ToastRegion({ children }: ToastRegionProps) {
  const canMount = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (!canMount) {
    return null;
  }

  return createPortal(
    <div className={styles.region} data-toast-region="true">
      {children}
    </div>,
    document.body,
  );
}
