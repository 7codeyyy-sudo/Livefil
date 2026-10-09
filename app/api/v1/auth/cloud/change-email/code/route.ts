/**
 * `POST /api/v1/auth/cloud/change-email/code`（AUTH-002，《接口文档》v0.8 #7，
 * 改邮箱双验证第一半）。
 *
 * 验当前密码（失败 401 统一文案）→ 频控 → 向**新**邮箱发码。
 * 恒定 200 信封——新邮箱是否已注册的差异只在邮件侧（#8 才回 409）。
 */
import { NextResponse } from 'next/server';

import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';
import { parseOrThrow, readJsonBody } from '../../../../../../_lib/validation.ts';
import { createApiRouteHandler } from '../../../../../../_lib/api-route.ts';
import { assertCloudMode } from '../../../../../../_lib/auth-route.ts';
import { createSendChangeEmailCodeUseCase } from '../../../../../../_lib/auth-deps.ts';
import { resolveSession } from '../../../../../../_lib/session-api.ts';
import { changeEmailCodeSchema } from '@/modules/identity/application/auth-schemas.ts';
import { getEmailSender } from '../../../../../../../composition-root.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    assertCloudMode();
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const payload = parseOrThrow(changeEmailCodeSchema, await readJsonBody(request));

    const session = await resolveSession(request);
    if (session.sessionId === null) {
      throw new Error('unreachable: cloud session missing');
    }

    const emailSender = getEmailSender();
    const useCase = createSendChangeEmailCodeUseCase();
    await useCase.execute(
      session.userId,
      { newEmail: payload.newEmail, currentPassword: payload.currentPassword },
      // 发信动作经参数注入：用例不感知传输（端口在领域层，HTTP/mock 在基础设施）。
      (to: string, code: string) =>
        emailSender.sendVerificationCode({ to, code, purpose: 'change_email' }),
    );

    // 恒定信封（防枚举）：不回传新邮箱是否已注册。
    const { status, body } = toSuccessResponse({ sent: true }, requestId);
    return NextResponse.json(body, { status });
  },
  { operation: 'auth_cloud_change_email_code' },
);
