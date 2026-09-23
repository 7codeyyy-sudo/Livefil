/** `GET/POST /api/v1/fixed-commitments`（SCHED-002，接口 §6 / DB §4.16）。 */
import { NextResponse } from 'next/server';

import {
  ManageFixedCommitmentUseCase,
  blockWindowQuerySchema,
  createFixedCommitmentSchema,
} from '@/modules/scheduling/application/manage-scheduling';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../_lib/validation.ts';
import { getAuditLogger, getRepositories } from '../../../../composition-root.ts';

function useCase(): ManageFixedCommitmentUseCase {
  const repositories = getRepositories();
  return new ManageFixedCommitmentUseCase({
    blocks: repositories.scheduleBlocks,
    fixed: repositories.fixedCommitments,
    tasks: repositories.tasks,
    audit: getAuditLogger(),
  });
}

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const query = parseOrThrow(
      blockWindowQuerySchema,
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const items = await useCase().listWindow(session.userId, query);
    const { status, body } = toSuccessResponse({ items }, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'fixed_commitment_list' },
);

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const payload = parseOrThrow(createFixedCommitmentSchema, await readJsonBody(request));
    const created = await useCase().create(session.userId, payload, requestId);
    const { status, body } = toSuccessResponse(created, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'fixed_commitment_create' },
);
