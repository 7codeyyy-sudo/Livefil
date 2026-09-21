/**
 * `GET /api/v1/goals/{goalId}`（详情聚合）与 `PATCH /api/v1/goals/{goalId}`
 * （GOAL-001/002，《接口文档》§5）。
 *
 * 详情一次带回目标 + 行动 + 行动进度（仓储层单查询聚合）；结果进度
 * （`resultMetric`）随目标本体，由用户就地手动维护。
 */
import { NextResponse } from 'next/server';

import { ManageGoalUseCase } from '@/modules/goals/application/manage-goal.ts';
import {
  toGoalDetailDto,
  toGoalDto,
  updateGoalSchema,
} from '@/modules/goals/application/goal-dto.ts';
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

export const GET = createApiRouteHandler<GoalRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { goalId } = await context.params;

    const detail = await useCase().findDetail(session.userId, goalId);

    const { status, body } = toSuccessResponse(toGoalDetailDto(detail), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'goal_detail' },
);

export const PATCH = createApiRouteHandler<GoalRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { goalId } = await context.params;

    const payload = parseOrThrow(updateGoalSchema, await readJsonBody(request));
    const { version, ...patch } = payload;

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const updated = await useCase().update(session.userId, goalId, version, patch, requestId);
        return toSuccessResponse(toGoalDto(updated), requestId);
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'goal_update' },
);
