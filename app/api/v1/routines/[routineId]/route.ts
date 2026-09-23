/** `PATCH/DELETE /api/v1/routines/{routineId}`（ROUTINE-001，接口 §8）。 */
import { NextResponse } from 'next/server';

import {
  ManageRoutineUseCase,
  updateRoutineSchema,
} from '@/modules/routines/application/manage-routine';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../_lib/validation.ts';
import { getAuditLogger, getRepositories } from '../../../../../composition-root.ts';

interface RoutineRouteContext {
  readonly params: Promise<{ readonly routineId: string }>;
}

function useCase(): ManageRoutineUseCase {
  const repositories = getRepositories();
  return new ManageRoutineUseCase({
    routines: repositories.routines,
    blocks: repositories.scheduleBlocks,
    fixedCommitments: repositories.fixedCommitments,
    lifeAreas: repositories.lifeAreas,
    audit: getAuditLogger(),
  });
}

export const PATCH = createApiRouteHandler<RoutineRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { routineId } = await context.params;
    const payload = parseOrThrow(updateRoutineSchema, await readJsonBody(request));
    const updated = await useCase().update(session.userId, routineId, payload, requestId);
    const { status, body } = toSuccessResponse(updated, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'routine_update' },
);

export const DELETE = createApiRouteHandler<RoutineRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { routineId } = await context.params;
    await useCase().delete(session.userId, routineId, requestId);
    const { status, body } = toSuccessResponse(null, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'routine_delete' },
);
