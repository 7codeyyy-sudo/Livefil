/**
 * `GET /api/v1/sync/pull`（SYNC-001，《接口文档》§12.1.2）。
 *
 * 返回当前用户自游标之后的变更与新游标。游标不透明：客户端只原样回传。
 */
import { NextResponse } from 'next/server';

import { PullChangesUseCase } from '@/modules/sync/application/pull-changes.ts';
import { pullChangesQuerySchema, toSyncChangeDto } from '@/modules/sync/application/sync-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';
import { serverEnv } from '@/shared/validation/env.server.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { parseOrThrow } from '../../../../_lib/validation.ts';
import { getRepositories } from '../../../../../composition-root.ts';

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const query = parseOrThrow(
      pullChangesQuerySchema,
      Object.fromEntries(request.nextUrl.searchParams),
    );

    const result = await new PullChangesUseCase({
      sync: getRepositories().sync,
      // 安全滞后窗口来自环境变量（缺省 5 秒）：它是运维口径而不是业务规则，
      // 所以走配置而不是写成常量——出问题时第一个要调的就是它。
      lagMs: serverEnv.syncPullLagMs,
    }).execute(session.userId, { cursor: query.cursor, limit: query.limit });

    const { status, body } = toSuccessResponse(
      { changes: result.changes.map(toSyncChangeDto), nextCursor: result.nextCursor },
      requestId,
    );

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'sync_pull' },
);
