/**
 * `POST /api/v1/auth/cloud/logout`（AUTH-002，《接口文档》v0.8 #4）。
 *
 * 经 `resolveSession` 取当前会话（认证部署无/坏/过期会话 ⇒ 401，契约 #4 失败列）。
 * 幂等：吊销已吊销的行仍 200；成功后清除 Cookie。
 */
import { NextResponse } from 'next/server';

import { AuthenticationError } from '@/shared/errors/app-error.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';
import { serverEnv } from '@/shared/validation/env.server.ts';
import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { assertCloudMode } from '../../../../../_lib/auth-route.ts';
import { createLogoutUseCase } from '../../../../../_lib/auth-deps.ts';
import { resolveSession } from '../../../../../_lib/session-api.ts';
import { SESSION_COOKIE_NAME } from '@/modules/identity/presentation/session-cookie.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    assertCloudMode();
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));

    // 认证部署下 resolveSession 失败即 401（契约 #4 失败列）；成功必带 sessionId。
    const session = await resolveSession(request);
    if (session.sessionId === null) {
      // 形态门禁保证 cloud 分支恒产出 sessionId；不可达路径按未认证处理。
      throw new AuthenticationError('需要登录后继续');
    }

    const useCase = createLogoutUseCase();
    await useCase.execute(session.userId, session.sessionId);

    const { body } = toSuccessResponse({ loggedOut: true }, requestId);
    const response = NextResponse.json(body, { status: 200 });
    // 清除 Cookie：maxAge=0 让浏览器立即丢弃（同名同属性，覆盖原 Cookie）。
    response.cookies.set(SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: serverEnv.nodeEnv === 'production',
      path: '/',
      maxAge: 0,
    });
    return response;
  },
  { operation: 'auth_cloud_logout' },
);
