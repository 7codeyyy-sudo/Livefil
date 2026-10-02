/**
 * `GET /api/v1/ai/usage`（AI-006，《接口文档》§11、RD-20260929-006 §1.5）。
 *
 * 返回用户本周期（用户时区自然月）的已用次数 / 成本与剩余额度。响应只含计数与
 * 整数分金额，不含任何 prompt 或用户内容——账本本身就不存内容（DB §4.13.2）。
 */
import { NextResponse } from 'next/server';

import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { getGetAiUsageUseCase } from '../../../../../composition-root.ts';

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const usage = await getGetAiUsageUseCase().execute(session.userId);

    const { status, body } = toSuccessResponse(usage, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'ai_usage_get' },
);
