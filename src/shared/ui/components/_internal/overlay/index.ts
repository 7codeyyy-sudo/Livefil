/**
 * 浮层内部基建的统一出口（UI-002 批次 3a）。
 *
 * **刻意不出现在 `../../index.ts`**：这是 Modal / ConfirmDialog / Drawer / Toast
 * 共用的实现细节，不是对外 API。§2.4 明确要求「供 3b 复用，不对外导出通用浮层框架」——
 * 一旦它进了公共出口，调用方就会开始直接组合 OverlayShell + 自定义面板，
 * 于是无障碍行为（焦点陷阱、滚动锁、退场卸载）在多处各写一遍，最终一定会漂移。
 */
export { OverlayPortal } from './OverlayPortal';
export type { OverlayPortalProps } from './OverlayPortal';
export { OverlayShell } from './OverlayShell';
export type { OverlayShellProps } from './OverlayShell';
export { useDelayedUnmount } from './use-delayed-unmount';
export type { DelayedUnmount, OverlayPhase } from './use-delayed-unmount';
export { useEscapeKey } from './use-escape-key';
export { useFocusTrap } from './use-focus-trap';
export { useScrollLock } from './use-scroll-lock';
