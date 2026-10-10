'use client';

/**
 * 401 跳转守卫（AUTH-002，RD-012 §5.3；v0.26 UI-010 C2「401 不落应用空态」）。
 *
 * ## 注册点为什么是 `(app)` 根
 *
 * `api-client` 只暴露 `setUnauthorizedHandler` 挂点（同 `setSyncWriteSink`
 * 的「端口在消费方」模式）：本组件在 `(app)` 组挂载时注册跳转、卸载时注销——
 * `(auth)` 组**不注册**，于是登录页自身的 401（凭据错误行）只展示不跳转，
 * 循环无从发生。本地部署下 401 不可达（自动会话），本组件静默空转——
 * 「本地不受影响」判据在前端侧的对应（RD-012 §5.4）。
 *
 * ## `?next=` 同源回跳（B4）
 *
 * 目标地址在 **handler 触发时**读 `window.location`（而不是注册时闭包捕获）：
 * 闭包值会在路由变化后跳到旧页；也不用 `useSearchParams`（那会把本组件拖进
 * Suspense 边界，week/page 同款理由）。同源校验 `^\/(?!\/)` 防开放跳转，
 * 跳转用 `router.push`（客户端导航，不用 `location.assign`——lint 规则同款要求）。
 *
 * ## 同步后台 401（RD-012 §5.3）
 *
 * 同步请求经同一 `readEnvelope`：401 触发本跳转，**IndexedDB 队列不被触碰**
 * （入队只发生在「无响应」的网络失败路径，401 是服务端已答复）——重登录后
 * 队列自动续推，这正是「暂停推送不清队列」。
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { setUnauthorizedHandler } from '../_lib/api-client';

export function SessionGuard() {
  const router = useRouter();

  useEffect(() => {
    const unregister = setUnauthorizedHandler(() => {
      const { pathname, search } = window.location;
      const target = `${pathname}${search}`;
      // 同源回跳校验（B4）：站内单斜杠路径且不在登录页（防循环），否则回登录页。
      const safe = /^\/(?!\/)/.test(target) && !target.startsWith('/login') ? target : '/login';
      router.push(`/login?next=${encodeURIComponent(safe)}`);
    });
    return unregister;
  }, [router]);

  return null;
}
