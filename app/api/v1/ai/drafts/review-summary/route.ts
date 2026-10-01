/**
 * `POST /api/v1/ai/drafts/review-summary`（AI-006，《接口文档》§11、FR-083）。
 *
 * 只读用户勾选范围（任务事实 / 开销摘要）的聚合数字。四类禁区（医疗 / 心理 /
 * 投资 / 借贷）由 system prompt 约束 + `ai-advice-policy.ts` 的输出后拦截双重保证
 * ——命中禁区的输出按「生成失败」落 `AI_RESPONSE_INVALID`，响应 `summary` 为空。
 */
import { NextResponse } from 'next/server';

import {
  reviewSummaryRequestSchema,
  toAiDraftResponseDto,
} from '@/modules/ai/application/ai-draft-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../../_lib/validation.ts';
import { getGenerateAiDraftUseCase } from '../../../../../../composition-root.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const payload = parseOrThrow(reviewSummaryRequestSchema, await readJsonBody(request));
    const draft = await getGenerateAiDraftUseCase().generateReviewSummary(session.userId, payload);

    const { status, body } = toSuccessResponse(toAiDraftResponseDto(draft), requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'ai_draft_review_summary' },
);
