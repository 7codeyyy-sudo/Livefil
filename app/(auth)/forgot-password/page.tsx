/**
 * 忘记密码页 `/forgot-password`（AUTH-002，v0.26 UI-010 C3）。
 *
 * 无查询参数——两步状态全在客户端 panel（同 login/register 的分工先例）。
 */
import { ForgotPasswordPanel } from './_components/ForgotPasswordPanel';

export const metadata = { title: '忘记密码' };

export default function ForgotPasswordPage() {
  return <ForgotPasswordPanel />;
}
