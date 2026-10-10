/**
 * 账号操作的接口封装（AUTH-002，v0.26 分区 9 的三个写操作）。
 *
 * 三个端点均属认证部署（`APP_MODE=cloud`）——本地部署不渲染分区 9，
 * 这些函数天然不被调用（RD-012 §5.4「本地不受影响」在 UI 侧的对应）。
 */
import { sendJson } from '../../_lib/api-client';
import type { ApiEnvelope } from '../../_lib/api-client';

/** 改密码（#6）：验当前密码 → 更新 → 吊销其余会话（保留当前）。 */
export function changePassword(input: {
  readonly currentPassword: string;
  readonly newPassword: string;
}): Promise<ApiEnvelope<{ readonly changed: boolean }>> {
  return sendJson<{ changed: boolean }>('POST', '/api/v1/auth/cloud/password', input);
}

/** 改邮箱·发码（#7，双验证第一半）。恒定 200（防枚举）。 */
export function sendChangeEmailCode(input: {
  readonly newEmail: string;
  readonly currentPassword: string;
}): Promise<ApiEnvelope<{ readonly sent: boolean }>> {
  return sendJson<{ sent: boolean }>('POST', '/api/v1/auth/cloud/change-email/code', input);
}

/** 改邮箱·提交（#8，双验证第二半）：核码 + 再验当前密码。 */
export function changeEmail(input: {
  readonly newEmail: string;
  readonly code: string;
  readonly currentPassword: string;
}): Promise<ApiEnvelope<{ readonly email: string }>> {
  return sendJson<{ email: string }>('POST', '/api/v1/auth/cloud/change-email', input);
}

/** 登出（#4）：吊销当前会话（幂等）+ 服务端清 Cookie。 */
export function logout(): Promise<ApiEnvelope<{ readonly loggedOut: boolean }>> {
  return sendJson<{ loggedOut: boolean }>('POST', '/api/v1/auth/cloud/logout');
}
