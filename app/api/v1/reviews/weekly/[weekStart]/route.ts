/**
 * `GET /api/v1/reviews/weekly/{weekStart}`（REVIEW-002，《接口文档》§10）。
 *
 * 周**已结束**时惰性物化快照并返回存量；周**未结束**时实时计算、不落库
 * （`snapshotSchemaVersion` 为 `null`）。物化时机与不变性由用例与 DB §4.11.2 定义。
 */
import { NextResponse } from 'next/server';

import { ManageReviewUseCase } from '@/modules/reviews/application/manage-review.ts';
import {
  reviewWeekStartParamSchema,
  toWeeklyReviewDto,
} from '@/modules/reviews/application/review-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';
import { parseOrThrow } from '../../../../../_lib/validation.ts';
import { getAuditLogger, getRepositories } from '../../../../../../composition-root.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
interface WeeklyReviewRouteContext {
  readonly params: Promise<{ readonly weekStart: string }>;
}

function useCase(): ManageReviewUseCase {
  const repositories = getRepositories();
  return new ManageReviewUseCase({
    reviews: repositories.reviews,
    facts: repositories.reviewFacts,
    adjustments: repositories.reviewAdjustments,
    users: repositories.users,
    tasks: repositories.tasks,
    goals: repositories.goals,
    expenses: repositories.expenses,
    audit: getAuditLogger(),
  });
}

export const GET = createApiRouteHandler<WeeklyReviewRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { weekStart } = await context.params;
    parseOrThrow(reviewWeekStartParamSchema, { weekStart });

    const view = await useCase().getWeekly(session.userId, weekStart);

    const { status, body } = toSuccessResponse(toWeeklyReviewDto(weekStart, view), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'review_weekly_get' },
);
