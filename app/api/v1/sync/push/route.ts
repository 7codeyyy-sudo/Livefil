/**
 * `POST /api/v1/sync/push`（SYNC-003，《接口文档》§12、§12.1.1）。
 *
 * 提交本地 outbox 操作，**逐条**返回处理状态。HTTP 整体 200：一条失败不影响同批
 * 其余操作（所以这里刻意不用 `withIdempotency`，它的语义是整请求级 409 重放）。
 */
import { NextResponse } from 'next/server';

import { ConflictService } from '@/modules/sync/application/conflict-service.ts';
import { PushOperationsUseCase } from '@/modules/sync/application/push-operations.ts';
import { pushOperationsSchema, toPushOperationInput } from '@/modules/sync/application/sync-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../_lib/validation.ts';
import { getIdempotencyStore, getRepositories } from '../../../../../composition-root.ts';

function useCase(): PushOperationsUseCase {
  const repositories = getRepositories();
  return new PushOperationsUseCase({
    apply: repositories.syncApply,
    idempotency: getIdempotencyStore(),
    conflicts: new ConflictService({
      conflicts: repositories.syncConflicts,
      apply: repositories.syncApply,
    }),
  });
}

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const payload = parseOrThrow(pushOperationsSchema, await readJsonBody(request));

    const results = await useCase().execute(
      session.userId,
      payload.operations.map(toPushOperationInput),
    );

    const { status, body } = toSuccessResponse({ results }, requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'sync_push' },
);
