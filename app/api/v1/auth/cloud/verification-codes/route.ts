/**
 * `POST /api/v1/auth/cloud/verification-codes`（AUTH-002，《接口文档》v0.8 #1）。
 *
 * **恒定 200**——邮箱存在性、purpose 可满足性不进响应（防枚举矩阵
 * RD-012 §4.4：差异只在邮件内容）。失败只有两种：400（格式）与 429（限流）。
 * 本地部署下经 `assertCloudMode` 返回结构化 404（双态总则）。
 */
import { NextResponse } from 'next/server';

import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';
import { parseOrThrow, readJsonBody } from '../../../../../_lib/validation.ts';
import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { assertCloudMode, clientIp } from '../../../../../_lib/auth-route.ts';
import { createSendCodeUseCase } from '../../../../../_lib/auth-deps.ts';
import { sendCodeSchema } from '@/modules/identity/application/auth-schemas.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    assertCloudMode();
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const payload = parseOrThrow(sendCodeSchema, await readJsonBody(request));

    const useCase = createSendCodeUseCase();
    await useCase.execute({
      identifier: payload.identifier,
      purpose: payload.purpose,
      ip: clientIp(request),
    });

    // 恒定信封：不回传任何分流信息（RD-012 §4.4）。
    const { status, body } = toSuccessResponse({ sent: true }, requestId);
    return NextResponse.json(body, { status });
  },
  { operation: 'auth_cloud_send_code' },
);
