/**
 * `GET /api/v1/goals`（列表）与 `POST /api/v1/goals`（创建）
 * （GOAL-001，《接口文档》§5）。
 */
import { NextResponse } from 'next/server';

import { ManageGoalUseCase } from '@/modules/goals/application/manage-goal.ts';
import {
  createGoalSchema,
  listGoalsQuerySchema,
  toGoalDto,
} from '@/modules/goals/application/goal-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { withIdempotency } from '../../../_lib/idempotency.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../_lib/validation.ts';
import {
  getAuditLogger,
  getIdempotencyStore,
  getRepositories,
} from '../../../../composition-root.ts';

function useCase(): ManageGoalUseCase {
  const repositories = getRepositories();
  return new ManageGoalUseCase({
    goals: repositories.goals,
    actions: repositories.actions,
    lifeAreas: repositories.lifeAreas,
    audit: getAuditLogger(),
  });
}

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const query = parseOrThrow(
      listGoalsQuerySchema,
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const page = await useCase().list(session.userId, query);

    const { status, body } = toSuccessResponse(
      { items: page.items.map(toGoalDto) },
      requestId,
      new Date(),
      { nextCursor: page.nextCursor, hasMore: page.hasMore },
    );

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'goal_list' },
);

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const payload = parseOrThrow(createGoalSchema, await readJsonBody(request));

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const created = await useCase().create(
          session.userId,
          {
            name: payload.name,
            lifeAreaId: payload.lifeAreaId ?? null,
            reason: payload.reason ?? null,
            targetDate: payload.targetDate ?? null,
          },
          requestId,
        );
        return toSuccessResponse(toGoalDto(created), requestId);
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'goal_create' },
);
