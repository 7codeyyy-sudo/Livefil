import { ViewTransition } from 'react';
import type { ReactNode } from 'react';

/**
 * 路由切换过渡（《UI 页面规范》§6 交互和动效）。
 *
 * ## 为什么是 `template` 而不是 `layout`
 *
 * 两者的差别只有一条：**`layout` 跨导航复用，`template` 每次导航重新挂载**。
 * React 的 `<ViewTransition>` 靠「旧节点卸载 + 新节点挂载」这一对事件触发出场
 * 与入场，而布局里的节点从不卸载——把包装放进 `layout` 的话进场与退场永远不
 * 会触发（Next 官方指南对此有一句原文：Layouts persist across navigations,
 * so enter and exit never fire there）。放 `template` 正好拿到「每个路由一份、
 * 且逐次重挂」的边界。
 *
 * ## 它管的是「页面切一刀」这一件事
 *
 * 浮层的进退场另有基建负责（`_internal/overlay/use-delayed-unmount`，靠
 * `data-state` 与 `onTransitionEnd` 延迟卸载）——那是**同一页内**的浮层，
 * 与这里的**跨路由整体替换**是两件事，互不替代、也不共用实现。
 *
 * ## 为什么 `default="none"`
 *
 * 不写它时，未命名的过渡会在**任何**过渡里都跑一遍自己的入场（例如页内
 * Suspense 从骨架落到内容时也会触发一次），结果是一次导航叠两层淡入。
 * 显式声明成 none，等于把「我只在整页进出场时出现」写进声明里。
 *
 * 动画本体在 `app/globals.css`：`::view-transition-old/new(.page-fade)`。
 * 那里只动 `opacity`（纯淡入，无位移——§1.1 禁止夸张渐入），时长与缓动引用
 * §2.4 的 `--duration-base` / `--ease-standard`。引用令牌而不是写时长字面量，
 * 也让 `prefers-reduced-motion` 在 tokens.css 的**单点**降级自动生效：那两个
 * 伪元素继承根元素的自定义属性，令牌被覆盖成近零时过渡自然归零。
 */
export default function AppGroupTemplate({ children }: { readonly children: ReactNode }) {
  return (
    <ViewTransition enter="page-fade" exit="page-fade" default="none">
      {children}
    </ViewTransition>
  );
}
