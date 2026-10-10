/**
 * `POST /api/v1/auth/cloud/register`（AUTH-002，《接口文档》v0.8 #2）。
 *
 * 注册即登录：核码（原子）→ 建号（单事务播种）→ 新会话行 + `Set-Cookie`（201）。
 * 核码失败统一 400 文案（四态只进安全事件）；username 撞名 409 字段级——
 * 前提是请求已持有效邮箱验证码（枚举须先过控制邮箱门槛，RD-012 §9-B2）。
 */
import { NextResponse } from 'next/server';

import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';
import { parseOrThrow, readJsonBody } from '../../../../../_lib/validation.ts';
import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import {
  assertCloudMode,
  clientIp,
  setAuthCookie,
  userAgentOf,
} from '../../../../../_lib/auth-route.ts';
import { createRegisterUseCase } from '../../../../../_lib/auth-deps.ts';
import { registerSchema } from '@/modules/identity/application/auth-schemas.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    assertCloudMode();
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const payload = parseOrThrow(registerSchema, await readJsonBody(request));

    const useCase = createRegisterUseCase();
    const result = await useCase.execute({
      email: payload.email,
      code: payload.code,
      username: payload.username,
      displayName: payload.displayName,
      password: payload.password,
      ip: clientIp(request),
      userAgent: userAgentOf(request),
    });

    const { body } = toSuccessResponse({ mode: 'cloud', userId: result.userId }, requestId);
    const response = NextResponse.json(body, { status: 201 });
    setAuthCookie(response, result.session.token);
    return response;
  },
  { operation: 'auth_cloud_register' },
);
