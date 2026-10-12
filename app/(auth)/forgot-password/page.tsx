/**
 * 忘记密码页 `/forgot-password`（AUTH-002，v0.26 UI-010 C3；PD-029 第 3 项降级态）。
 *
 * 无查询参数；读 `serverEnv.emailEnabled` 传给 panel 决定整页形态（降级态＝
 * 「联系管理员重置」说明）。**动态渲染**（force-dynamic）：每请求读当前 env，
 * 改 `EMAIL_API_URL` 重启后形态立即正确、不需重新 build（拍板 3 前提）。
 *
 * v0.30：窄栏容器（`.shell`）由 `(auth)` 布局下移到本页——登录页换成整页 hero
 * 面后，`(auth)` 布局不再统一持窄栏（见 `../layout.tsx` 注记）。DOM 与 v0.26
 * 完全一致（`<main class="shell">` 仍是 panel 的直接父节点）。
 */
import { ForgotPasswordPanel } from './_components/ForgotPasswordPanel';
import { serverEnv } from '@/shared/validation/env.server.ts';

import styles from '../auth.module.css';

export const metadata = { title: '忘记密码' };

// 每请求读 env（邮件通道形态的单一分支点），不做静态固化。
export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage() {
  return (
    <main className={styles.shell}>
      <ForgotPasswordPanel emailEnabled={serverEnv.emailEnabled} />
    </main>
  );
}
