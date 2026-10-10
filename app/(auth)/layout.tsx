import type { ReactNode } from 'react';

import styles from './auth.module.css';

/**
 * 认证页路由组布局（AUTH-002，v0.26 UI-010 C0；RD-012 §5/§9-B11）。
 *
 * ## 为什么不挂应用外壳
 *
 * C0 明文：`(auth)` 与 `(app)` 并列、**不挂侧栏/顶栏/快速添加**——登录与注册
 * 时用户还没有会话，外壳里的导航（今日/收件箱/设置…）全是不可达的死链接；
 * 零装饰同时是「好看高级简约」的落点（无插画、无 §3.4 装饰背景）。
 *
 * ## 服务端布局
 *
 * 页面本身是客户端组件（步骤状态、表单草稿都在客户端），布局保持服务端：
 * 窄栏骨架先于 hydration 渲染，避免内容闪动。单列 400px 居中是本组
 * **唯一新布局量**（B11 单点披露，值在 `auth.module.css` 的 `.shell`）。
 *
 * ## 401 不在此处理
 *
 * 401 处理器只在 `(app)` 根注册（`SessionGuard`）——登录页自身的 401 是
 * 凭据错误行而非「会话失效」，本组天然不注册，跳转循环无从发生
 * （RD-012 §5.3）。
 */
export default function AuthLayout({ children }: { readonly children: ReactNode }) {
  return <main className={styles.shell}>{children}</main>;
}
