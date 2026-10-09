/**
 * `POST /api/v1/auth/cloud/password-reset`（AUTH-002，《接口文档》v0.8 #5）。
 *
 * 核码（统一 400）→ 更新密码 → **全量吊销含当前会话**（RD-012 §3 流 5 策略表：
 * 重置流程无法验证当前会话归属，宁可多踢）。本端点不需要已登录——
 * 已登录态访问允许且不拦截（§9-B8），完成后因全量吊销自然回到未登录。
 */
import { NextResponse } from 'next/server';

import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';
import { parseOrThrow, readJsonBody } from '../../../../../_lib/validation.ts';
import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { assertCloudMode } from '../../../../../_lib/auth-route.ts';
import { createResetPasswordUseCase } from '../../../../../_lib/auth-deps.ts';
import { passwordResetSchema } from '@/modules/identity/application/auth-schemas.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    assertCloudMode();
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const payload = parseOrThrow(passwordResetSchema, await readJsonBody(request));

    // 限流（§14.1 重置族）在用例内判定——依赖方向：路由不得引用领域层（App Router 规则）。
    const useCase = createResetPasswordUseCase();
    await useCase.execute({
      email: payload.email,
      code: payload.code,
      newPassword: payload.newPassword,
    });

    const { status, body } = toSuccessResponse({ reset: true }, requestId);
    return NextResponse.json(body, { status });
  },
  { operation: 'auth_cloud_password_reset' },
);
