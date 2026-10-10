/**
 * `POST /api/v1/account/deletion-request/cancel`（OPS-002，《接口文档》§13；
 * 八定值「cancel 端点随批」）。
 *
 * 需有效会话（登录态）——发起删除时会话已全吊销，撤销必须**重新登录**后
 * 操作（契约原文）。200 幂等：无活跃请求也回 200（`cancelled:false`）。
 */
import { NextResponse } from 'next/server';

import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { createDeletionUseCases } from '../../../../../_lib/data-deps.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const result = await createDeletionUseCases().cancel.execute(session.userId);

    const { status, body } = toSuccessResponse(result, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'account_deletion_cancel' },
);
