'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';

import { OfflineBanner } from '@/shared/ui/components';

import { MobileNavDrawer } from '../MobileNavDrawer/MobileNavDrawer';
import { Sidebar } from '../Sidebar/Sidebar';
import { Topbar } from '../Topbar/Topbar';

import styles from './AppShell.module.css';

export type AppShellProps = {
  /** 当前页专属操作，透传给 `Topbar`（见 `TopbarProps.pageActions` 的限制说明）。 */
  readonly pageActions?: ReactNode | undefined;
  /** 页面内容。由 `app/(app)/layout.tsx` 以 `children` 传入，仍是服务端组件。 */
  readonly children: ReactNode;
};

/**
 * 应用外壳（UI-003，《UI 页面规范》v0.12 §3.2）。
 *
 * ## 它是客户端组件，页面内容却不是
 *
 * 外壳要持有"导航抽屉是否展开"这一个状态，因此必须是客户端组件。
 * 但 `children` 是**已经渲染好的元素**，由服务端的 `app/(app)/layout.tsx`
 * 传进来——客户端组件转发 `children` 不会把它们拖进客户端包。
 * 六个占位页因此保持服务端渲染。
 *
 * ## 三档形态只由 CSS 决定
 *
 * `232px 展开 / 72px 折叠 / 单列` 三个网格模板都写在样式里，靠媒体查询切换；
 * **JS 侧不判断视口宽度**。原因是项目有一条机器断言：TS/TSX 里不得出现断点
 * 像素值（目前没有、也不该为此新建断点镜像文件）。这也正好与原型一致——
 * 原型的折叠与抽屉切换同样是 CSS 行为，JS 只负责那个 `.is-open` 类。
 */
export function AppShell({ pageActions, children }: AppShellProps) {
  const [isNavOpen, setIsNavOpen] = useState(false);

  function openNav(): void {
    setIsNavOpen(true);
  }

  function closeNav(): void {
    setIsNavOpen(false);
  }

  return (
    <div className={styles.shell}>
      <Sidebar />

      <div className={styles.main}>
        <Topbar isNavOpen={isNavOpen} onOpenNav={openNav} pageActions={pageActions} />

        {/* 离线横幅：内容区顶部、页面内容之上（§4.7）。它刻意不是浮层——
            在文档流里意味着页面内容会被顺势下推，而不是被盖住。 */}
        <OfflineBanner />

        <main className={styles.page} data-app-page="true">
          {children}
        </main>
      </div>

      {/* 抽屉挂在 body（由 OverlayPortal 负责），所以它放在哪个 JSX 位置
          都不影响视觉；放在外壳里只是让它与状态同源。 */}
      <MobileNavDrawer open={isNavOpen} onClose={closeNav} />
    </div>
  );
}
