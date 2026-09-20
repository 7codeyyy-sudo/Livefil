'use client';

import styles from './OfflineBanner.module.css';
import { useOnlineStatus } from './use-online-status';

/**
 * 离线横幅（《UI 页面规范》v0.14 §4.7，UI-004）。
 *
 * ## 它为什么不是 Toast，也不是 ErrorState
 *
 * - **不是 Toast**：Toast 是瞬时的（几秒后自己消失），而离线是一个持续状态——
 *   用户需要随时能看到「我现在看到的东西可能不是最新的」。
 * - **不是 ErrorState**：ErrorState 是**阻塞**的，它宣告「这一块没能加载出来」。
 *   离线不等于内容不可用：已经加载过的、缓存的、纯本地的内容照样能看，
 *   把它整块遮掉是把「提醒」误做成了「故障」。
 *
 * 所以它是三者之外的第四种形态：**持久、内联、非模态**。
 *
 * ## 位置由使用方决定
 *
 * 组件自己不带定位（不 `fixed`、不 `sticky`），它就是文档流里的一个块。
 * 规范要求它「挂在 AppShell 内容区顶部、页面内容之上」，那个位置由
 * `AppShell` 的 JSX 顺序表达——组件不该知道自己在页面里的坐标。
 *
 * ## `role="status"`
 *
 * 离线瞬间就该被读屏播报（等价 `aria-live="polite"`），而不是等用户 Tab 过来。
 * 恢复在线时组件整体卸载，因此不存在「需要主动播报恢复」的问题。
 */
export function OfflineBanner() {
  const isOnline = useOnlineStatus();

  if (isOnline) {
    return null;
  }

  return (
    <div className={styles.banner} role="status" data-offline-banner="true">
      <p className={styles.inner}>当前处于离线状态，显示的内容可能不是最新</p>
    </div>
  );
}
