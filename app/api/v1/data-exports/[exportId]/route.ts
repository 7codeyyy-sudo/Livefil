/**
 * `GET /api/v1/data-exports/{exportId}`（OPS-002，《接口文档》§13）。
 *
 * 状态与短期下载地址（契约三态；`failed` 不带 `downloadUrl`）。
 * 他人的 exportId ⇒ 404（不泄露存在性）。
 */
import { NextResponse } from 'next/server';

import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { createExportStatusUseCase } from '../../../../_lib/data-deps.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';

interface ExportStatusContext {
  readonly params: Promise<{ readonly exportId: string }>;
}

export const GET = createApiRouteHandler<ExportStatusContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { exportId } = await context.params;

    const result = createExportStatusUseCase().execute(session.userId, exportId, new Date());

    const { status, body } = toSuccessResponse(result, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'data_export_status' },
);
