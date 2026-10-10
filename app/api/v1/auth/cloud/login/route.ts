/**
 * `POST /api/v1/auth/cloud/login`（AUTH-002，《接口文档》v0.8 #3）。
 *
 * 双通道单端点（互斥二选一由 schema 保证）。**失败一律 401 统一文案**——
 * 查无/密码错/码失败不区分（防枚举矩阵 RD-012 §4.4）；429 限流统一文案。
 * 成功：新会话行 + 新令牌（会话固定防护——入站 sid 永不复用）。
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
import { createLoginUseCase } from '../../../../../_lib/auth-deps.ts';
import { loginSchema } from '@/modules/identity/application/auth-schemas.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    assertCloudMode();
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const payload = parseOrThrow(loginSchema, await readJsonBody(request));

    const useCase = createLoginUseCase();
    const result = await useCase.execute({
      identifier: payload.identifier,
      password: payload.password,
      code: payload.code,
      ip: clientIp(request),
      userAgent: userAgentOf(request),
    });

    const { body } = toSuccessResponse({ mode: 'cloud', userId: result.userId }, requestId);
    const response = NextResponse.json(body, { status: 200 });
    setAuthCookie(response, result.session.token);
    return response;
  },
  { operation: 'auth_cloud_login' },
);
