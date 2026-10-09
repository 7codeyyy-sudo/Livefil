/**
 * 注册页 `/register`（AUTH-002，v0.26 UI-010 C1；RD-012 §9-B1/B2/B7）。
 *
 * 无查询参数——三步状态全在客户端 panel；服务端边界只负责元数据
 * （同 login/page 与 week/page 的分工先例）。
 */
import { RegisterPanel } from './_components/RegisterPanel';

export const metadata = { title: '创建账号' };

export default function RegisterPage() {
  return <RegisterPanel />;
}
