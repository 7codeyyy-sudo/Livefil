import type { ReactNode } from 'react';

import { AppShell } from '@/shared/ui/layout/AppShell/AppShell';

import { SyncStatusContainer } from './_components/SyncStatusContainer';

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
 */
export default function AppGroupLayout({ children }: { readonly children: ReactNode }) {
  return <AppShell syncBanner={<SyncStatusContainer />}>{children}</AppShell>;
}
