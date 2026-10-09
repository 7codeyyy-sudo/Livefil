/**
 * `POST /api/v1/data-exports`（OPS-002，《接口文档》§13）。
 *
 * 创建导出作业并同步生成内容（契约「导出可能异步完成」的三态由作业状态
 * 承载：生成失败 ⇒ 作业 `failed` + 安全事件，POST 本身照常返回任务 id）。
 * 限流 5 次/小时/用户（八定值）。
 */
import { NextResponse } from 'next/server';

import { exportRequestSchema } from '@/modules/data-management/application/data-schemas.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { createExportUseCase } from '../../../_lib/data-deps.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../_lib/validation.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const payload = parseOrThrow(exportRequestSchema, await readJsonBody(request));

    const result = await createExportUseCase().execute(session.userId, payload.format ?? 'json');

    const { status, body } = toSuccessResponse(result, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'data_export_create' },
);
