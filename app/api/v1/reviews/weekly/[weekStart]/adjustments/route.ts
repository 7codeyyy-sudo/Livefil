/**
 * `POST /api/v1/reviews/weekly/{weekStart}/adjustments`（REVIEW-003，《接口文档》§10）。
 *
 * 「记录 + 执行（同一事务）」：本路由只做形状校验与入参翻译，事务由
 * `ReviewAdjustmentApplier` 承担。返回入列后的完整清单（B2 第 7 项），
 * **不提供撤销**（B4 冻结）。
 *
 * 带 `Idempotency-Key` 时走幂等编排（追加式写入，重试不该落两条）；
 * 不带时原样执行——接口 §10 未强制该头（与 §7 执行记录的强制口径不同）。
 */
import { NextResponse } from 'next/server';

import { ManageReviewUseCase } from '@/modules/reviews/application/manage-review.ts';
import {
  createAdjustmentSchema,
  reviewWeekStartParamSchema,
  toAdjustmentPayload,
  toReviewAdjustmentDto,
} from '@/modules/reviews/application/review-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../../_lib/api-route.ts';
import { withIdempotency } from '../../../../../../_lib/idempotency.ts';
import { resolveSession, withSessionCookie } from '../../../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../../../_lib/validation.ts';
import {
  getAuditLogger,
  getIdempotencyStore,
  getRepositories,
} from '../../../../../../../composition-root.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
interface AdjustmentRouteContext {
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

export const POST = createApiRouteHandler<AdjustmentRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { weekStart } = await context.params;
    parseOrThrow(reviewWeekStartParamSchema, { weekStart });

    const payload = parseOrThrow(createAdjustmentSchema, await readJsonBody(request));

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const adjustments = await useCase().createAdjustment(
          session.userId,
          weekStart,
          {
            targetType: payload.targetType,
            targetId: payload.targetId,
            action: payload.action,
            payload: toAdjustmentPayload(payload.action, payload.payload),
          },
          requestId,
        );
        return toSuccessResponse(
          { adjustments: adjustments.map(toReviewAdjustmentDto) },
          requestId,
        );
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'review_adjustment_create' },
);
