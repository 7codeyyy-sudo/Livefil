/**
 * `POST /api/v1/goals/{goalId}/actions`（GOAL-002，《接口文档》§5）。
 *
 * 在目标下创建行动；行动进度随之变化（详情页的"行动进度"由行动状态汇总，
 * 无需单独写进度）。
 */
import { NextResponse } from 'next/server';

import { ManageGoalUseCase } from '@/modules/goals/application/manage-goal.ts';
import { createActionSchema, toActionDto } from '@/modules/goals/application/goal-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { withIdempotency } from '../../../../../_lib/idempotency.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../../_lib/validation.ts';
import {
  getAuditLogger,
  getIdempotencyStore,
  getRepositories,
} from '../../../../../../composition-root.ts';

interface GoalRouteContext {
  readonly params: Promise<{ readonly goalId: string }>;
}

function useCase(): ManageGoalUseCase {
  const repositories = getRepositories();
  return new ManageGoalUseCase({
    goals: repositories.goals,
    actions: repositories.actions,
    lifeAreas: repositories.lifeAreas,
    audit: getAuditLogger(),
  });
}

export const POST = createApiRouteHandler<GoalRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { goalId } = await context.params;

    const payload = parseOrThrow(createActionSchema, await readJsonBody(request));

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const created = await useCase().createAction(
          session.userId,
          goalId,
          {
            name: payload.name,
            targetFrequency: payload.targetFrequency ?? null,
            estimatedMinutes: payload.estimatedMinutes ?? null,
            minimumVersion: payload.minimumVersion ?? null,
          },
          requestId,
        );
        return toSuccessResponse(toActionDto(created), requestId);
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'goal_action_create' },
);
