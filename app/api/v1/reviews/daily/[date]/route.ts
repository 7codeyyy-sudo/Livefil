/**
 * `GET /api/v1/reviews/daily/{date}`（读取）与
 * `PUT /api/v1/reviews/daily/{date}`（幂等保存）（REVIEW-001，《接口文档》§10）。
 *
 * PUT 的幂等由**唯一键** `(user_id, review_type = 'daily', period_key = {date})` 承担
 * （接口 §10 明文），因此不再叠加 Idempotency-Key 编排：重复保存本就该命中同一行，
 * 而不是被当成"重放"返回 409。
 */
import { NextResponse } from 'next/server';

import { ManageReviewUseCase } from '@/modules/reviews/application/manage-review.ts';
import {
  dailyReviewUpsertSchema,
  reviewDateParamSchema,
  toDailyReviewDto,
} from '@/modules/reviews/application/review-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../../_lib/validation.ts';
import { getAuditLogger, getRepositories } from '../../../../../../composition-root.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
interface DailyReviewRouteContext {
  readonly params: Promise<{ readonly date: string }>;
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

export const GET = createApiRouteHandler<DailyReviewRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { date } = await context.params;
    parseOrThrow(reviewDateParamSchema, { date });

    const view = await useCase().getDaily(session.userId, date);

    // 既没填写、也没有任何事实 → `data: null`（空态），与 404/5xx 的失败态分开。
    const { status, body } = toSuccessResponse(
      view === null ? null : toDailyReviewDto(date, view),
      requestId,
    );

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'review_daily_get' },
);

export const PUT = createApiRouteHandler<DailyReviewRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { date } = await context.params;
    parseOrThrow(reviewDateParamSchema, { date });

    const payload = parseOrThrow(dailyReviewUpsertSchema, await readJsonBody(request));

    await useCase().upsertDaily(
      session.userId,
      date,
      { answers: payload.answers, energyLevel: payload.energyLevel },
      requestId,
    );

    // 回读响应而不是直接复用写入结果：客户端拿到的形状与 GET 完全一致，
    // 不必为"保存后要自己拼事实摘要"再发一次请求。
    const view = await useCase().getDaily(session.userId, date);
    const { status, body } = toSuccessResponse(
      view === null ? null : toDailyReviewDto(date, view),
      requestId,
    );

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'review_daily_upsert' },
);
