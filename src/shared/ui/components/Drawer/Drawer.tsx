'use client';

import { useId } from 'react';
import type { ReactNode } from 'react';

import { IconButton } from '../IconButton/IconButton';
import { OverlayShell } from '../_internal/overlay';

import styles from './Drawer.module.css';

export type DrawerProps = {
  readonly open: boolean;
  /** 关闭请求（ESC、点遮罩、点 X）。调用方决定是否真的关闭。 */
  readonly onClose: () => void;
  /** 面板标题，同时作为无障碍名称（`aria-labelledby`）。 */
  readonly title: string;
  /** 正文：编辑表单的唯一落点。 */
  readonly children: ReactNode;
  /**
   * 底部操作区，通常是按钮组。
   *
   * 三段结构里只有它是可选的：正文可能长到滚出视野，操作栏因此**钉在面板底部**
   * 而不是跟着滚——否则用户填完最后一项还得滚回去找「保存」。
   */
  readonly footer?: ReactNode | undefined;
  /** 初始焦点的选择器（相对面板）。不给则聚焦面板本身。 */
  readonly initialFocusSelector?: string | undefined;
  /** 是否渲染 Header 右侧的关闭按钮，默认 `true`。 */
  readonly closable?: boolean | undefined;
};

/**
 * 详情编辑抽屉（《UI 页面规范》§4.5，v0.8 冻结形态）。
 *
 * ## 与 Modal 的关系
 *
 * **共用机制、不共用 UI**，与 ConfirmDialog 是同一套切分：两者都走
 * `OverlayShell`（挂 body、遮罩、滚动锁、ESC、焦点陷阱、退场延迟卸载），
 * 差异只有面板落点。所以这里传 `layout="edge"`，让遮罩把面板贴到右侧，
 * 而不是给 Modal 加一个 `direction` 参数。
 *
 * ## 三处形态取值只来自 §4.5
 *
 * 1. **桌面右侧滑入、宽 `min(440px, 100vw)`**；**≤767px 全屏**——移动端在
 *    「底部抽屉 / 全屏页面」之间冻结为全屏，避免编辑表单撞上虚拟键盘。
 * 2. **位移用 `--duration-base`**（原型抽屉 180ms 的归整值），不是 Modal 的
 *    `--duration-slow`；遮罩在同一套 CSS 里同步（见 `OverlayPortal.module.css`）。
 * 3. **不做方向引擎**：原型那个 250px 左滑物是移动端导航 sidebar，归 UI-003 外壳。
 *
 * ## 为什么初始焦点落在面板而不是第一个输入框
 *
 * 与 Modal 同因：打开即聚焦输入框会让移动端立刻弹出虚拟键盘、把刚出现的
 * 抽屉顶掉一半。默认聚焦面板本身，用户按 Tab 再进表单——面板带 `tabIndex={-1}`
 * 才可被程序聚焦，这一点由 `OverlayShell` 统一保证。
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  initialFocusSelector,
  closable = true,
}: DrawerProps) {
  const titleId = useId();

  return (
    <OverlayShell
      open={open}
      onClose={onClose}
      role="dialog"
      labelledBy={titleId}
      layout="edge"
      initialFocusSelector={initialFocusSelector}
      panelClassName={styles.panel}
    >
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {closable ? (
          <IconButton label="关闭" onClick={onClose} data-variant="drawer-close">
            ×
          </IconButton>
        ) : null}
      </header>

      {/* `data-drawer-body` 供浏览器端用例精确定位这一层：类名带哈希，而
          「Body 是唯一滚动区、Header/Footer 不跟着滚」这条只能在真实布局里验。 */}
      <div className={styles.body} data-drawer-body="true">
        {children}
      </div>

      {footer === undefined ? null : <footer className={styles.footer}>{footer}</footer>}
    </OverlayShell>
  );
}
