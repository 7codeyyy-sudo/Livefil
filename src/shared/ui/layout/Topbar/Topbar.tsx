'use client';

import type { ReactNode } from 'react';

import { Button, IconButton } from '@/shared/ui/components';
import { clientEnv } from '@/shared/validation/env.client';

import { NAV_DRAWER_ID } from '../MobileNavDrawer/MobileNavDrawer';

import styles from './Topbar.module.css';

export type TopbarProps = {
  /** 移动端导航抽屉是否已展开（决定汉堡按钮的 `aria-expanded`）。 */
  readonly isNavOpen: boolean;
  readonly onOpenNav: () => void;
  /**
   * 当前页的专属操作。
   *
   * 规范 §3.2 冻结「顶部工具栏只放当前页必要操作」。本批六个页面都是占位页，
   * 页面级操作为零，所以外壳不渲染这个容器（而不是渲染一个空盒子）。
   *
   * ⚠️ **跨布局边界注入的限制**：`AppShell` 由 `app/(app)/layout.tsx` 渲染，
   * 而页面是它的 `children`——页面无法反过来给父级传 props。UI-005 要把
   * 「今日复盘」放进来时，需要在并行路由（`@actions` 槽）与"由外壳按
   * `usePathname` 决定操作"之间选一条，届时再定。
   */
  readonly pageActions?: ReactNode | undefined;
};

/**
 * 顶部工具栏（UI-003，《UI 页面规范》v0.12 §3.2）。
 *
 * ## 与原型的两处差异（都是刻意的）
 *
 * 1. **不含「今日复盘」**。原型把它常驻顶栏，是因为原型只有一个今日页；
 *    而"只放当前页必要操作"在当前（六个占位页、零页面级操作）的含义就是
 *    ——只有全站级的「快速添加」。页面级操作走 `pageActions` 槽。
 * 2. **内容与页面区对齐**：原型顶栏自带 `clamp(24px,5vw,72px)` 内边距、
 *    不参与最大宽度约束，宽屏下它的右边缘与页面区右边缘并不重合。
 *    这里让顶栏内容落在同一个 1200px 容器里，操作按钮与页面内容右对齐。
 *
 * ## 「＋ 快速添加」为什么是个没有 `onClick` 的按钮
 *
 * 它的行为（打开快速添加面板）属 TASK-002。本批只交付入口：标签完整保留、
 * 可见、可聚焦、**不 disable**——禁用态会让它在视觉上像"功能坏了"，
 * 而它其实是"功能还没接"。代码侧不留空函数：没有 `onClick` 就是没有行为，
 * 比一个什么都不做的回调更诚实。
 */
export function Topbar({ isNavOpen, onOpenNav, pageActions }: TopbarProps) {
  return (
    <header className={styles.topbar}>
      <div className={styles.inner}>
        {/* 移动端品牌（原型 `.mobile-brand`）：桌面/平板隐藏。
            刻意用 `<div>` 而非链接——与原型一致，且这一屏已经有一个返回
            今日页的入口（底部导航/汉堡抽屉）。 */}
        <div className={styles.mobileBrand}>
          <span className={styles.brandMark} aria-hidden="true">
            {clientEnv.appName.slice(0, 1)}
          </span>
          <span>{clientEnv.appName}</span>
        </div>

        <div className={styles.actions}>
          {pageActions === undefined ? null : (
            <div className={styles.pageActions}>{pageActions}</div>
          )}

          <Button variant="primary" data-variant="quick-add">
            ＋ 快速添加
          </Button>

          {/* 汉堡：仅手机出现。`IconButton` 不接受 `className`，所以外层套一个
              受媒体查询控制的定位槽——按钮自身的尺寸与样式归组件所有。 */}
          <span className={styles.navToggleSlot}>
            <IconButton
              label="切换导航"
              aria-expanded={isNavOpen}
              aria-controls={NAV_DRAWER_ID}
              onClick={onOpenNav}
              data-nav-toggle="true"
            >
              ☰
            </IconButton>
          </span>
        </div>
      </div>
    </header>
  );
}
