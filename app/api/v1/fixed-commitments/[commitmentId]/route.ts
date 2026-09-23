/** `PATCH/DELETE /api/v1/fixed-commitments/{id}`（接口 §6；实例/模板语义见用例）。 */
import { NextResponse } from 'next/server';

import {
  ManageFixedCommitmentUseCase,
  updateFixedCommitmentSchema,
} from '@/modules/scheduling/application/manage-scheduling';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { withIdempotency } from '../../../../_lib/idempotency.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../_lib/validation.ts';
import {
  getAuditLogger,
  getIdempotencyStore,
  getRepositories,
} from '../../../../../composition-root.ts';

interface CommitmentRouteContext {
  readonly params: Promise<{ readonly commitmentId: string }>;
}

function useCase(): ManageFixedCommitmentUseCase {
  const repositories = getRepositories();
  return new ManageFixedCommitmentUseCase({
    blocks: repositories.scheduleBlocks,
    fixed: repositories.fixedCommitments,
    tasks: repositories.tasks,
    audit: getAuditLogger(),
  });
}

export const PATCH = createApiRouteHandler<CommitmentRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { commitmentId } = await context.params;
    const payload = parseOrThrow(updateFixedCommitmentSchema, await readJsonBody(request));
    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const updated = await useCase().update(session.userId, commitmentId, payload, requestId);
        return toSuccessResponse(updated, requestId);
      },
    );
    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'fixed_commitment_update' },
);

export const DELETE = createApiRouteHandler<CommitmentRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { commitmentId } = await context.params;
    await useCase().delete(session.userId, commitmentId, requestId);
    const { status, body } = toSuccessResponse(null, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'fixed_commitment_delete' },
);
