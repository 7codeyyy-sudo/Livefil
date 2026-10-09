import type { ReactNode } from 'react';

import { AppShell } from '@/shared/ui/layout/AppShell/AppShell';

import { BackgroundFieldContainer } from './_components/BackgroundFieldContainer';
import { GuideTourLayer } from './_components/GuideTourLayer';
import { GuideTourProvider } from './_components/GuideTourProvider';
import { HelpDrawerContainer } from './_components/HelpDrawerContainer';
import { SyncStatusContainer } from './_components/SyncStatusContainer';
import { NotificationsContainer } from './_components/NotificationsContainer';

/**
 * 应用外壳路由组 `(app)` 的布局（UI-003）。
 *
 * ## 为什么是路由组
 *
 * `(app)` 带括号，因此**不进入 URL**：`app/(app)/today/page.tsx` 对应的地址
 * 就是 `/today`。它的作用是让这六个业务页面共用外壳，而不把它套到别处：
 *
 * - `app/styleguide/` 是组件裸展示夹具——套上外壳会连同导航与顶栏一起改变
 *   它现有的浏览器断言，而它要验证的是组件本身。
 * - `app/api/**` 是接口，本来就不该有页面布局。
 *
 * 组名取 `(app)` 是按规范 v0.12 §3.2 的写法。
 *
 * ## 这里为什么是服务端组件
 *
 * 状态（导航抽屉开合）在客户端组件 `AppShell` 里，`children` 只是被透传，
 * 六个占位页因此保持服务端渲染。
 *
 * 同步状态横幅（SYNC-002）同理：它是客户端组件，但作为 `syncBanner` 插槽
 * 传给 `AppShell`——外壳不与同步模块耦合，六态的唯一挂载点仍在这里。
 *
 * 通知铃铛（NOTIFY-002，UI v0.23 §5 B）走 `notificationBell` 槽，理由同上：
 * 提醒数据来自 notifications 模块，共享层不能反向依赖它。容器同时带出面板
 * 抽屉，而抽屉经 `OverlayPortal` 挂到 `body`，所以它虽然挂在顶栏也不占页头。
 *
 * 帮助入口（AI-002，UI v0.22 §5 B）走 `helpEntry` 槽，同理：路由到文案的映射
 * 与引导进度都属应用层。`GuideTourProvider` 包住整个外壳，使**顶栏里的**帮助
 * 抽屉与**全屏导览层**共用同一份「已看过」进度（抽屉要能"重新查看新手引导"，
 * 而它挂在每次都存在的顶栏上，状态只能活在共同祖先里）。
 *
 * 新手导览层（AI-007，UI v0.25「新手引导形态升版补节」）也挂在这里：§ A 要求
 * 载体挂在 `(app)` 外壳层、**跨页存活**（分页触发、不跳路由）。它经
 * `createPortal` 自行挂到 `body`，因此放在 `AppShell` 之后不影响外壳布局。
 *
 * 装饰性背景（UI-009）也挂在这里：它是固定定位、负层级的独立一层，与外壳内容
 * 平级即可，不需要进入 `AppShell` 的任何一个插槽。它只在 `(app)` 组下生效。
 */
export default function AppGroupLayout({ children }: { readonly children: ReactNode }) {
  return (
    <GuideTourProvider>
      <BackgroundFieldContainer />
      <AppShell
        syncBanner={<SyncStatusContainer />}
        notificationBell={<NotificationsContainer />}
        helpEntry={<HelpDrawerContainer />}
      >
        {children}
      </AppShell>
      <GuideTourLayer />
    </GuideTourProvider>
  );
}
