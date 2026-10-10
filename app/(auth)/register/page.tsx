/**
 * 注册页 `/register`（AUTH-002，v0.26 UI-010 C1；PD-029 第 1/3 项双态）。
 *
 * 无查询参数；读 `serverEnv.emailEnabled` 传给 panel 决定形态：
 * - 降级态＝邀请码 + 账号 + 名字 + 密码（单表单，分发单第 4 行四项）；
 * - 全形态＝邀请码 + 原三步邮箱验证（邀请码在步 1，与邮箱同收）。
 * **动态渲染**（force-dynamic）：每请求读当前 env，改 `EMAIL_API_URL` 重启后
 * 形态立即正确、不需重新 build（拍板 3「读 env 自动回归」的前提）。
 */
import { RegisterPanel } from './_components/RegisterPanel';
import { serverEnv } from '@/shared/validation/env.server.ts';

export const metadata = { title: '创建账号' };

// 每请求读 env（注册形态的单一分支点），不做静态固化。
export const dynamic = 'force-dynamic';

export default function RegisterPage() {
  return <RegisterPanel emailEnabled={serverEnv.emailEnabled} />;
}
