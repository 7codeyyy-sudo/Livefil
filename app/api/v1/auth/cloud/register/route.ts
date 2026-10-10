/**
 * `POST /api/v1/auth/cloud/register`（AUTH-002，《接口文档》v0.8 #2；
 * **PD-029 拍板「1+2」勘误**：免邮箱验证 + 邀请码制注册）。
 *
 * 注册即登录：邀请码门 + IP 限流（双闸）→ 建号（单事务播种；email 选填、
 * 不验证、`emailVerifiedAt` 恒 null）→ 新会话行 + `Set-Cookie`（201）。
 * 邀请码失败统一 400 文案（无码/错码不分型，防枚举）；username 撞名 409
 * 字段级——**枚举门槛自「有效邮箱验证码」降为「邀请码 + IP 限流」**
 * （原前提随免验证消失，PD-029 第 5 项安全面披露）。
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
      // PD-029 勘误：inviteCode 取代 email/code 两步——email 选填、不验证。
      inviteCode: payload.inviteCode,
      email: payload.email,
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
