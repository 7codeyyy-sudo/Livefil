/** `PATCH/DELETE /api/v1/schedule-blocks/{blockId}`（SCHED-002/003，接口 §6）。 */
import { NextResponse } from 'next/server';

import {
  ManageScheduleBlockUseCase,
  updateScheduleBlockSchema,
} from '@/modules/scheduling/application/manage-scheduling';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../_lib/validation.ts';
import { getAuditLogger, getRepositories } from '../../../../../composition-root.ts';

interface BlockRouteContext {
  readonly params: Promise<{ readonly blockId: string }>;
}

function useCase(): ManageScheduleBlockUseCase {
  const repositories = getRepositories();
  return new ManageScheduleBlockUseCase({
    blocks: repositories.scheduleBlocks,
    fixed: repositories.fixedCommitments,
    tasks: repositories.tasks,
    audit: getAuditLogger(),
  });
}

export const PATCH = createApiRouteHandler<BlockRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { blockId } = await context.params;
    const payload = parseOrThrow(updateScheduleBlockSchema, await readJsonBody(request));
    const result = await useCase().update(session.userId, blockId, payload, requestId);
    const { status, body } = toSuccessResponse(
      {
        ...result.block,
        startsAtUtc: result.block.startsAtUtc.toISOString(),
        endsAtUtc: result.block.endsAtUtc.toISOString(),
        conflictState: result.conflictState,
        conflicts: result.conflicts,
      },
      requestId,
    );
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'schedule_block_update' },
);

export const DELETE = createApiRouteHandler<BlockRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { blockId } = await context.params;
    await useCase().cancel(session.userId, blockId, requestId);
    const { status, body } = toSuccessResponse(null, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'schedule_block_cancel' },
);
