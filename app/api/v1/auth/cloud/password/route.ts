/**
 * `POST /api/v1/auth/cloud/password`（AUTH-002，《接口文档》v0.8 #6，改密码）。
 *
 * 已登录：验当前密码（失败 401 统一文案）→ 新密码过 B1 规则 → 更新 →
 * **吊销其余会话、保留当前**（RD-012 §3 流 5 策略表）。
 */
import { NextResponse } from 'next/server';

import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';
import { parseOrThrow, readJsonBody } from '../../../../../_lib/validation.ts';
import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { assertCloudMode } from '../../../../../_lib/auth-route.ts';
import { createChangePasswordUseCase } from '../../../../../_lib/auth-deps.ts';
import { resolveSession } from '../../../../../_lib/session-api.ts';
import { changePasswordSchema } from '@/modules/identity/application/auth-schemas.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    assertCloudMode();
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const payload = parseOrThrow(changePasswordSchema, await readJsonBody(request));

    const session = await resolveSession(request);
    if (session.sessionId === null) {
      // 形态门禁保证 cloud 分支恒产出 sessionId；不可达路径按未认证处理。
      throw new Error('unreachable: cloud session missing');
    }

    const useCase = createChangePasswordUseCase();
    await useCase.execute(session.userId, session.sessionId, {
      currentPassword: payload.currentPassword,
      newPassword: payload.newPassword,
    });

    const { status, body } = toSuccessResponse({ changed: true }, requestId);
    return NextResponse.json(body, { status });
  },
  { operation: 'auth_cloud_password_change' },
);
