/**
 * `POST /api/v1/auth/cloud/change-email`（AUTH-002，《接口文档》v0.8 #8，
 * 改邮箱双验证第二半）。
 *
 * 核码（统一 400）+ 再验当前密码（401）→ 更新邮箱（新邮箱占用 409 字段级）→
 * **吊销其余会话、保留当前**（同改密码策略，RD-012 §3 流 5）。
 */
import { NextResponse } from 'next/server';

import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';
import { parseOrThrow, readJsonBody } from '../../../../../_lib/validation.ts';
import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { assertCloudMode } from '../../../../../_lib/auth-route.ts';
import { createChangeEmailUseCase } from '../../../../../_lib/auth-deps.ts';
import { resolveSession } from '../../../../../_lib/session-api.ts';
import { changeEmailSchema } from '@/modules/identity/application/auth-schemas.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    assertCloudMode();
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const payload = parseOrThrow(changeEmailSchema, await readJsonBody(request));

    const session = await resolveSession(request);
    if (session.sessionId === null) {
      throw new Error('unreachable: cloud session missing');
    }

    const useCase = createChangeEmailUseCase();
    await useCase.execute(session.userId, session.sessionId, {
      newEmail: payload.newEmail,
      code: payload.code,
      currentPassword: payload.currentPassword,
    });

    const { status, body } = toSuccessResponse({ email: payload.newEmail }, requestId);
    return NextResponse.json(body, { status });
  },
  { operation: 'auth_cloud_change_email' },
);
