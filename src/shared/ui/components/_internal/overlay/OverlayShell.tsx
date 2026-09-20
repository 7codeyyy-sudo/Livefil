'use client';

import { useRef } from 'react';
import type { ReactNode } from 'react';

import { OverlayPortal } from './OverlayPortal';
import type { OverlayLayout } from './OverlayPortal';
import { useDelayedUnmount } from './use-delayed-unmount';
import { useEscapeKey } from './use-escape-key';
import { useFocusTrap } from './use-focus-trap';
import { useScrollLock } from './use-scroll-lock';

export type OverlayShellProps = {
  readonly open: boolean;
  /** 关闭请求：ESC、点遮罩、点 X 都汇到这里，由调用方决定是否真的关。 */
  readonly onClose: () => void;
  readonly role: 'dialog' | 'alertdialog';
  /** 指向标题元素的 id，作为无障碍名称。 */
  readonly labelledBy: string;
  /** 指向描述元素的 id（ConfirmDialog 用；可选）。 */
  readonly describedBy?: string | undefined;
  /** 初始焦点的选择器（相对面板）。不给则聚焦面板本身。 */
  readonly initialFocusSelector?: string | undefined;
  /**
   * 面板落点。默认居中；Drawer 传 `edge`（贴右满高），
   * UI-003 的移动端导航抽屉传 `edge-left`（贴左满高）。
   */
  readonly layout?: OverlayLayout | undefined;
  /**
   * 面板元素的 `id`（可选）。
   *
   * 供触发按钮的 `aria-controls` 指向被它控制的面板——UI-003 的汉堡按钮
   * 需要这层显式关联（`aria-expanded` 只说开合，`aria-controls` 才说明它
   * 控制的是**谁**）。默认不生成：Modal / ConfirmDialog / Drawer 的触发点
   * 分散在页面各处，没有这个需求，凭空生成一个 id 只是噪声。
   */
  readonly panelId?: string | undefined;
  /**
   * 面板类名。类型含 `undefined` 是因为 CSS Modules 的类名在
   * `noUncheckedIndexedAccess` 下就是 `string | undefined`——写成 `string`
   * 会让每个调用点都不得不用非空断言，把噪声推给调用方。
   */
  readonly panelClassName: string | undefined;
  readonly children: ReactNode;
};

/**
 * 浮层机制装配（浮层内部基建，批次 3a）。
 *
 * 把「挂到 body + 遮罩 + 三个行为 hook（滚动锁 / ESC / 焦点陷阱）+ 退场延迟卸载」
 * 组装成一个可复用的壳，任一模态类浮层只负责提供面板内容与无障碍名称。
 *
 * **Modal 与 ConfirmDialog 共用它，而不是共用 Modal**：两者的机制完全一致，
 * 但 UI 不同（确认弹窗没有关闭图标、有描述正文、语义是 `alertdialog`）。
 * 让 ConfirmDialog 去改 Modal 的 props 来适配自己，会把 Modal 撑成一个
 * 参数越来越杂的万能组件；共享机制、各自表达用户界面才是正确的切分。
 *
 * 这个模块只在 `_internal` 里，不出现在组件公共出口——§2.4 明确要求
 * 「供 3b 复用，不对外导出通用浮层框架」。
 */
export function OverlayShell({
  open,
  onClose,
  role,
  labelledBy,
  describedBy,
  initialFocusSelector,
  layout = 'center',
  panelId,
  panelClassName,
  children,
}: OverlayShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { mounted, phase, onTransitionEnd } = useDelayedUnmount(open);

  /**
   * 行为 hook 的开关，比 `open` 晚一步。
   *
   * **必须是 `open && mounted`，不能只用 `open`**：面板是延迟挂载的（打开时要晚
   * 一帧、好让进场动画有起点），而 `open` 已经为 true 时 `panelRef.current`
   * 还是 `null`。此时若只依赖 `open`，焦点陷阱会拿着空容器直接返回，
   * 而且因为后续依赖不再变化，**它永远不会重试**——表现就是"弹窗打开了，
   * 焦点却留在背后页面上"。
   *
   * 反过来，`open` 变 false 时这个值立刻变 false，所以"用户一点关闭就解锁滚动、
   * 归还焦点"的行为不受影响；退场动画只是收尾，不该让页面继续被劫持。
   */
  const panelActive = open && mounted;

  // 滚动锁不依赖面板是否存在，用 `open` 即可——它要覆盖整个"意图打开"的时段。
  useScrollLock(open);
  useEscapeKey(panelRef, panelActive, onClose);
  useFocusTrap(panelRef, panelActive, initialFocusSelector);

  return (
    <OverlayPortal mounted={mounted} phase={phase} layout={layout} onScrimClick={onClose}>
      <div
        ref={panelRef}
        id={panelId}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        // 面板自身可聚焦：初始焦点默认落在它上面，而不是第一个按钮上——
        // 否则「打开弹窗」会顺带触发第一个按钮（在确认弹窗里那可能就是危险操作）。
        tabIndex={-1}
        data-state={phase}
        onTransitionEnd={onTransitionEnd}
        className={panelClassName}
      >
        {children}
      </div>
    </OverlayPortal>
  );
}
