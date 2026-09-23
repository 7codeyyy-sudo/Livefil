/** `GET/POST /api/v1/routines`（ROUTINE-001，接口 §8）。 */
import { NextResponse } from 'next/server';

import {
  ManageRoutineUseCase,
  createRoutineSchema,
} from '@/modules/routines/application/manage-routine';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../_lib/validation.ts';
import { getAuditLogger, getRepositories } from '../../../../composition-root.ts';

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

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const details = await useCase().listAll(session.userId);
    const { status, body } = toSuccessResponse({ items: details }, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'routine_list' },
);

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const payload = parseOrThrow(createRoutineSchema, await readJsonBody(request));
    const created = await useCase().create(session.userId, payload, requestId);
    const { status, body } = toSuccessResponse(created, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'routine_create' },
);
