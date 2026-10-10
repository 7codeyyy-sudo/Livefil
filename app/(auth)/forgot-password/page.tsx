/**
 * 忘记密码页 `/forgot-password`（AUTH-002，v0.26 UI-010 C3；PD-029 第 3 项降级态）。
 *
 * 无查询参数；读 `serverEnv.emailEnabled` 传给 panel 决定整页形态（降级态＝
 * 「联系管理员重置」说明）。**动态渲染**（force-dynamic）：每请求读当前 env，
 * 改 `EMAIL_API_URL` 重启后形态立即正确、不需重新 build（拍板 3 前提）。
 */
import { ForgotPasswordPanel } from './_components/ForgotPasswordPanel';
import { serverEnv } from '@/shared/validation/env.server.ts';

export const metadata = { title: '忘记密码' };

// 每请求读 env（邮件通道形态的单一分支点），不做静态固化。
export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage() {
  return <ForgotPasswordPanel emailEnabled={serverEnv.emailEnabled} />;
}
