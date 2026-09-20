'use client';

import { useSyncExternalStore } from 'react';

/**
 * 订阅浏览器的连通性事件。
 *
 * 提到模块作用域而不是写在 hook 里：`useSyncExternalStore` 会在每次渲染时
 * 比对 `subscribe` 的引用，内联函数会让它每次都重新订阅一遍。
 */
function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener('online', onStoreChange);
  window.addEventListener('offline', onStoreChange);

  return () => {
    window.removeEventListener('online', onStoreChange);
    window.removeEventListener('offline', onStoreChange);
  };
}

function getSnapshot(): boolean {
  return navigator.onLine;
}

/**
 * 服务端快照：一律按**在线**处理。
 *
 * 服务端没有 `navigator`，而这个值在服务端也取不到「用户此刻的连通性」——
 * 它只存在于客户端。返回 `true` 让首屏不带离线横幅；若浏览器真的离线，
 * 水合完成后会立即切到离线态。反过来（服务端渲离线、客户端在线）则会出现
 * 一条一闪而过的横幅，而那才是真正误导人的那一种。
 */
function getServerSnapshot(): boolean {
  return true;
}

/**
 * 当前是否在线（《UI 页面规范》v0.14 §4.7，UI-004）。
 *
 * ## 为什么用 `useSyncExternalStore`
 *
 * 连通性是一个**外部可变数据源**，不是 React 状态。用 `useState` + `useEffect`
 * 订阅的写法在首次渲染时拿不到真实值（首帧必然是在线），会造成一次可见的
 * 状态翻转；`useSyncExternalStore` 正是为「在渲染时安全读取外部数据源」而
 * 存在的 API，也自带 SSR 快照入口（上面那个函数）。
 *
 * ## 已知边界
 *
 * `navigator.onLine` 只表示「浏览器认为自己有网络」：连着局域网但出口不通时
 * 它仍报在线；不同实现对该值的更新时机也有差异。§4.7 明确：**不主动探测真实
 * 连通性**——那需要一次网络请求，代价与收益不成比例。真正的失败会被取数层
 * 捕获并以错误态呈现，两者分工不重叠。
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
