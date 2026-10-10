/**
 * 认证页的接口封装（AUTH-002，v0.26 UI-010 四件的取数出口）。
 *
 * 复用 `(app)/_lib/api-client` 的信封与错误归一（路由组只是文件组织——
 * `(auth)` 与 `(app)` 同属 `app/` 树，跨组引用合法且避免了两份会漂移的
 * fetch 实现）。**401 处理器不在此注册**：登录页自身的 401 是凭据错误行，
 * 触发跳转会造成循环——注册点在 `(app)` 根（RD-012 §5.3），天然不覆盖本组。
 */
import { sendJson } from '../../(app)/_lib/api-client';
import type { ApiEnvelope } from '../../(app)/_lib/api-client';

/** 发送验证码（#1）。**恒定成功语义**——失败只有 400 格式与 429 限流。 */
export function sendVerificationCode(input: {
  readonly identifier: string;
  readonly purpose: 'register' | 'login' | 'password_reset';
}): Promise<ApiEnvelope<{ readonly sent: boolean }>> {
  return sendJson<{ sent: boolean }>('POST', '/api/v1/auth/cloud/verification-codes', input);
}

/** 注册（#2）：核码 + 建号，成功即带会话。 */
export function register(input: {
  readonly email: string;
  readonly code: string;
  readonly username: string;
  readonly displayName?: string | null | undefined;
  readonly password: string;
}): Promise<ApiEnvelope<{ readonly mode: string; readonly userId: string }>> {
  return sendJson<{ mode: string; userId: string }>('POST', '/api/v1/auth/cloud/register', input);
}

/** 登录（#3）：互斥二选一通道。失败 401 统一文案。 */
export function login(input: {
  readonly identifier: string;
  readonly password?: string | undefined;
  readonly code?: string | undefined;
}): Promise<ApiEnvelope<{ readonly mode: string; readonly userId: string }>> {
  return sendJson<{ mode: string; userId: string }>('POST', '/api/v1/auth/cloud/login', input);
}

/** 密码重置（#5）。 */
export function resetPassword(input: {
  readonly email: string;
  readonly code: string;
  readonly newPassword: string;
}): Promise<ApiEnvelope<{ readonly reset: boolean }>> {
  return sendJson<{ reset: boolean }>('POST', '/api/v1/auth/cloud/password-reset', input);
}
