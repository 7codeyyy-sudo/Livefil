/**
 * `POST /api/v1/recycle-items/{entityType}/{itemId}/restore`（OPS-002，
 * 《接口文档》§13 回收区；FR-093 恢复方式的正身）。
 *
 * 清 `deleted_at`、`version+1`（同步实体恢复即产生一次变更，经增量流下发）；
 * 已恢复/不存在/非本人 ⇒ 404。`expenses` 既有的
 * `POST /expenses/{id}/restore` 等价入口保留不动（契约注记）。
 */
import { NextResponse } from 'next/server';

import { entityTypeSchema } from '@/modules/data-management/application/data-schemas.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { ValidationError } from '@/shared/errors/app-error.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../../_lib/api-route.ts';
import { createRecycleUseCases } from '../../../../../../_lib/data-deps.ts';
import { resolveSession, withSessionCookie } from '../../../../../../_lib/session-api.ts';

interface RestoreContext {
  readonly params: Promise<{ readonly entityType: string; readonly itemId: string }>;
}

export const POST = createApiRouteHandler<RestoreContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { entityType, itemId } = await context.params;

    const parsedType = entityTypeSchema.safeParse(entityType);
    if (!parsedType.success) {
      throw new ValidationError('不支持的实体类型');
    }

    await createRecycleUseCases().restore.execute(session.userId, parsedType.data, itemId);

    const { status, body } = toSuccessResponse({ restored: true }, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'recycle_restore' },
);
