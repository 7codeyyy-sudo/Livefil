/**
 * `POST /api/v1/sync/conflicts/{conflictId}/resolve`（SYNC-004，《接口文档》§12.1.3）。
 *
 * P0 只接受 `keep_server` / `keep_local`；`manual_merge` 顺延（收到即 400）。
 */
import { NextResponse } from 'next/server';

import { ConflictService } from '@/modules/sync/application/conflict-service.ts';
import { ResolveConflictUseCase } from '@/modules/sync/application/resolve-conflict.ts';
import { resolveConflictSchema } from '@/modules/sync/application/sync-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../../../_lib/validation.ts';
import { getRepositories } from '../../../../../../../composition-root.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
interface ConflictRouteContext {
  readonly params: Promise<{ readonly conflictId: string }>;
}

function useCase(): ResolveConflictUseCase {
  const repositories = getRepositories();
  return new ResolveConflictUseCase({
    conflicts: repositories.syncConflicts,
    conflictService: new ConflictService({
      conflicts: repositories.syncConflicts,
      apply: repositories.syncApply,
    }),
  });
}

export const POST = createApiRouteHandler<ConflictRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { conflictId } = await context.params;

    const payload = parseOrThrow(resolveConflictSchema, await readJsonBody(request));
    const conflict = await useCase().execute(session.userId, conflictId, payload.resolution);

    const { status, body } = toSuccessResponse({ conflict }, requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'sync_conflict_resolve' },
);
