/** `POST /api/v1/routines/{routineId}/schedule`（ROUTINE-001，接口 §8：物化展开）。 */
import { NextResponse } from 'next/server';

import {
  ManageRoutineUseCase,
  scheduleRoutineSchema,
} from '@/modules/routines/application/manage-routine';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../../_lib/validation.ts';
import { getAuditLogger, getRepositories } from '../../../../../../composition-root.ts';

interface RoutineRouteContext {
  readonly params: Promise<{ readonly routineId: string }>;
}

export const POST = createApiRouteHandler<RoutineRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { routineId } = await context.params;
    const payload = parseOrThrow(scheduleRoutineSchema, await readJsonBody(request));
    const repositories = getRepositories();
    const useCase = new ManageRoutineUseCase({
      routines: repositories.routines,
      blocks: repositories.scheduleBlocks,
      fixedCommitments: repositories.fixedCommitments,
      lifeAreas: repositories.lifeAreas,
      audit: getAuditLogger(),
    });
    const blocks = await useCase.scheduleOnDate(session.userId, routineId, payload, requestId);
    const { status, body } = toSuccessResponse(
      blocks.map((block) => ({
        ...block,
        startsAtUtc: block.startsAtUtc,
        endsAtUtc: block.endsAtUtc,
      })),
      requestId,
    );
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'routine_schedule' },
);
