/**
 * `POST /api/v1/data-imports/preview`（OPS-002，《接口文档》§13；FR-091）。
 *
 * 解析 + 体检、**零写入**；产出 30 分钟有效的 `importId`（八定值）。
 * 响应含双视角计数（merge 分类型 `{ total, 新增, 重复 }` + replace 的
 * `willClear`）与 `compatible`（契约：兼容判定由字段驱动，UI 不发明规则）。
 * 限流 10 次/小时/用户（八定值）。
 */
import { NextResponse } from 'next/server';

import { previewRequestSchema } from '@/modules/data-management/application/data-schemas.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { createPreviewImportUseCase } from '../../../../_lib/data-deps.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../_lib/validation.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const payload = parseOrThrow(previewRequestSchema, await readJsonBody(request));

    const result = await createPreviewImportUseCase().execute(session.userId, payload.file);

    const { status, body } = toSuccessResponse(result, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'data_import_preview' },
);
