/**
 * 登录页 `/login`（AUTH-002，v0.26 UI-010 C2；PD-029 第 3 项降级态）。
 *
 * 服务端做两件事：从 `searchParams` 取 `next`（401 跳转带来的回跳目标），
 * 读 `serverEnv.emailEnabled` 传给 panel 决定是否渲染验证码 Tab。
 *
 * **动态渲染**：读 `searchParams` 天然把本路由降级为 dynamic（week/page 同款），
 * 因此每请求读到的是当前 env——改 `EMAIL_API_URL` 重启后形态立即正确，
 * 不需要重新 build（拍板 3「读 env 自动回归」的前提）。
 */
import { LoginPanel } from './_components/LoginPanel';
import { serverEnv } from '@/shared/validation/env.server.ts';

export const metadata = { title: '登录' };

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | readonly string[] | undefined>>>;
}) {
  const params = await searchParams;
  const rawNext = params['next'];
  const next = typeof rawNext === 'string' ? rawNext : null;

  return <LoginPanel next={next} emailEnabled={serverEnv.emailEnabled} />;
}
