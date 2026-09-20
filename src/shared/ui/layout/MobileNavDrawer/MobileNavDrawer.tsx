'use client';

import { useId } from 'react';

import { OverlayShell } from '@/shared/ui/components/_internal/overlay';

import { SidebarContent } from '../SidebarContent';

import styles from './MobileNavDrawer.module.css';

/**
 * 汉堡按钮与抽屉之间的关联 id（单一来源）。
 *
 * 触发按钮要用 `aria-controls` 指向它控制的面板，所以这个字符串必须
 * 被两处引用。放在这里导出、由 `Topbar` 引入，避免两边各写一个字面量。
 */
export const NAV_DRAWER_ID = 'app-nav-drawer';

export type MobileNavDrawerProps = {
  readonly open: boolean;
  readonly onClose: () => void;
};

/**
 * 移动端导航抽屉（UI-003，《UI 页面规范》v0.12 §3.2）。
 *
 * ## 为什么是浮层，而不是把侧栏 `translateX` 移出屏幕
 *
 * 原型只有一份 `.sidebar`：窄屏把它改成 `position: fixed` 再整体左移。
 * 那种做法有个无障碍缺口——**移出视口的链接仍然可以被 Tab 聚焦**，
 * 键盘用户会走进一块看不见的区域（WCAG 焦点顺序）。v0.12 因此明确
 * 「遮罩、ESC 关闭、焦点陷阱、关闭后焦点归还、进退场延迟卸载，标准同 §4.5，
 * 复用 `_internal/overlay` 基建」，本组件就是那条要求的落地。
 *
 * 复用的收益是现成的：面板在关闭动画播完后**整个移出 DOM**（延迟卸载），
 * 所以关闭态不存在"躲在屏幕外还能聚焦"的元素；打开态由焦点陷阱把 Tab
 * 圈在抽屉内；关闭时焦点自动归还给汉堡按钮。
 *
 * ## 落点为什么是 `edge-left`
 *
 * 同一个 `OverlayShell` 已服务 Modal（居中）、ConfirmDialog（居中）、
 * Drawer（贴右）。这是第四个落点：它与 `Drawer` 组件的形态无关——
 * `Drawer` 是"右侧详情编辑抽屉"，职责明确；导航抽屉贴左是**遮罩的对齐方式**，
 * 属于 `OverlayPortal` 的 `layout`。两者的遮罩时长同为 `--duration-base`。
 *
 * ## 已知边界
 *
 * 抽屉打开期间把视口拉宽到 768px 以上，汉堡按钮会随媒体查询消失，
 * 而抽屉仍在——此时 ESC 与点遮罩仍可关闭，不会把人困住。
 * 彻底消除它需要在 JS 侧判断断点，而项目**禁止**在 TS/TSX 里写断点像素值
 * （`test:e2e` 的 `ui-001-acceptance` 有断言，且尚无镜像文件），
 * 所以这里保留该边界并记录在案，不为它引入第二份断点来源。
 */
export function MobileNavDrawer({ open, onClose }: MobileNavDrawerProps) {
  const titleId = useId();

  return (
    <OverlayShell
      open={open}
      onClose={onClose}
      role="dialog"
      labelledBy={titleId}
      layout="edge-left"
      panelId={NAV_DRAWER_ID}
      panelClassName={styles.panel}
    >
      {/* 抽屉需要自己的可访问名称。视觉上"汉堡唤出的就是导航"不言自明，
          但读屏只会听到"对话框"，所以补一个视觉隐藏的标题。 */}
      <h2 id={titleId} className={styles.visuallyHidden}>
        站点导航
      </h2>

      {/* `onNavigate={onClose}` 不是可选的修饰：抽屉是浮层，点里面的链接会完成
          路由切换，但**没有任何东西会因此关掉抽屉**——新页面会被抽屉与遮罩盖着、
          `body` 滚动还锁着，用户得再按一次 ESC 才看得到自己刚点的页面。
          ESC 与点遮罩走的是同一个 `onClose`，三条出口在这里汇合。 */}
      <SidebarContent onNavigate={onClose} />
    </OverlayShell>
  );
}
