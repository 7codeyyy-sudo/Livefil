/**
 * 登录页 `/login`（AUTH-002，v0.26 UI-010 C2；RD-012 §9-B4/B5）。
 *
 * 服务端只做一件事：从 `searchParams` 取 `next`（401 跳转带来的回跳目标）。
 * `useSearchParams` 会把整个页面降级到 Suspense 边界内（week/page.tsx 同款
 * 理由），所以取值在服务端边界完成，客户端 panel 只消费。
 */
import { LoginPanel } from './_components/LoginPanel';

export const metadata = { title: '登录' };

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | readonly string[] | undefined>>>;
}) {
  const params = await searchParams;
  const rawNext = params['next'];
  const next = typeof rawNext === 'string' ? rawNext : null;

  return <LoginPanel next={next} />;
}
