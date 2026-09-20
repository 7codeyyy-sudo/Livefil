/**
 * `POST /api/v1/auth/local/session`（IAM-001，《接口文档》§2）。
 *
 * 幂等确保本地会话：**无需请求体、无需凭证**。服务端在单事务内确保唯一本地用户
 * 与默认生活领域存在，经 `Set-Cookie` 下发签名会话。
 *
 * 为什么需要一个"显式创建会话"的端点，而 `GET /me` 已经会自动建立：前者是
 * 意图明确的动作（客户端启动时调用它，然后才去取数据），后者是兜底。两者
 * 调用同一个用例，因此不会出现"两种方式建立的会话不一样"这类分歧。
 */
import { NextResponse } from 'next/server';

import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    // 响应体只回 mode 与 userId（§2 的契约），**不含任何设置**：
    // 需要设置的是 `GET /me` 的职责，把两件事混在一个响应里会让"会话建立"
    // 这个动作顺带承诺它并不保证的数据。
    const { status, body } = toSuccessResponse(
      { mode: session.mode, userId: session.userId },
      requestId,
    );

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'auth_local_session_create' },
);
