/**
 * `POST /api/v1/account/deletion-request`（OPS-002，《接口文档》§13 删除面）。
 *
 * 7 天可撤销窗口（八定值）+ **发起即吊销全部会话**（跨批端口
 * `revokeAllSessions(userId)`，方向 data-management → identity——批 A 先立签名）。
 * 活跃期间重复发起幂等返回既有 pending（实现语义，RD-015 披露）。
 * 限流 3 次/天/用户（八定值）。响应体形状契约未定义，取最小三字段
 * `{ status, requestedAt, purgeAt }`（RD-015 披露提请追认）。
 */
import { NextResponse } from 'next/server';

import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { createDeletionUseCases } from '../../../../_lib/data-deps.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const result = await createDeletionUseCases().request.execute(session.userId);

    const { status, body } = toSuccessResponse(result, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'account_deletion_request' },
);
