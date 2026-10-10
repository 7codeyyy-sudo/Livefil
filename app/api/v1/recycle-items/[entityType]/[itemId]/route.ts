/**
 * `DELETE /api/v1/recycle-items/{entityType}/{itemId}`（OPS-002，《接口文档》§13；
 * 单条**永久删除**）。
 *
 * 物理行 + 事务防护（自引用模板先改挂，见 `recycle.drizzle.ts` 文件头）；
 * 「先备份纪律」＝每日备份覆盖可恢复性 + `DATA_DELETED` 安全事件留痕
 * （口径随 RD-015 披露）。不存在/非本人 ⇒ 404（不泄露存在性）。
 */
import { NextResponse } from 'next/server';

import { entityTypeSchema } from '@/modules/data-management/application/data-schemas.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { ValidationError } from '@/shared/errors/app-error.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { createRecycleUseCases } from '../../../../../_lib/data-deps.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';

interface RecycleItemContext {
  readonly params: Promise<{ readonly entityType: string; readonly itemId: string }>;
}

export const DELETE = createApiRouteHandler<RecycleItemContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { entityType, itemId } = await context.params;

    const parsedType = entityTypeSchema.safeParse(entityType);
    if (!parsedType.success) {
      // 非法类型＝400（参数错），而非 404：路径段的取值域是契约定义的枚举。
      throw new ValidationError('不支持的实体类型');
    }

    await createRecycleUseCases().remove.execute(session.userId, parsedType.data, itemId);

    const { status, body } = toSuccessResponse({ deleted: true }, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'recycle_remove' },
);
