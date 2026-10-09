/**
 * `GET /api/v1/recycle-items` 与 `DELETE /api/v1/recycle-items`
 * （OPS-002，《接口文档》§13 回收区；FR-093 选型「回收区恢复」）。
 *
 * - GET：跨类型列表，按删除时间倒序；`?limit=1–100（默认 100）`——单页
 *   上限＝八定值，不引入分页（Pagination 挂账 UI-005）。
 * - DELETE：清空回收区（全部类型），限流 10 次/小时/用户（八定值）；
 *   客户端须先过 ConfirmDialog（UI §4.5 危险纪律，服务端不重复拦）。
 * 响应形状（`{ items, retentionDays }` / `{ cleared }`）契约未定义，
 * 取最小字段（RD-015 披露）。
 */
import { NextResponse } from 'next/server';

import {
  recycleListQuerySchema,
  RETENTION_DAYS,
} from '@/modules/data-management/application/data-schemas.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { createRecycleUseCases } from '../../../_lib/data-deps.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow } from '../../../_lib/validation.ts';

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const query = parseOrThrow(
      recycleListQuerySchema,
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const all = await createRecycleUseCases().list.execute(session.userId);
    const items = all.slice(0, query.limit).map((item) => ({
      entityType: item.entityType,
      itemId: item.itemId,
      name: item.name,
      deletedAt: item.deletedAt.toISOString(),
    }));

    const { status, body } = toSuccessResponse({ items, retentionDays: RETENTION_DAYS }, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'recycle_list' },
);

export const DELETE = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const cleared = await createRecycleUseCases().clear.execute(session.userId);

    const { status, body } = toSuccessResponse({ cleared }, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'recycle_clear' },
);
