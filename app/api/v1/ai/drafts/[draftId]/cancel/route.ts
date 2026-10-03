/**
 * `POST /api/v1/ai/drafts/{draftId}/cancel`（AI-004/005/006，《接口文档》§11）。
 *
 * 取消草稿，**不写任何业务实体**。无请求体；草稿已过期或被消费时返 409。
 */
import { NextResponse } from 'next/server';

import { aiDraftIdParamSchema, toCancelDto } from '@/modules/ai/application/ai-draft-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../../../_lib/session-api.ts';
import { parseOrThrow } from '../../../../../../_lib/validation.ts';
import { getConfirmAiDraftUseCase } from '../../../../../../../composition-root.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
interface AiDraftRouteContext {
  readonly params: Promise<{ readonly draftId: string }>;
}

export const POST = createApiRouteHandler<AiDraftRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { draftId } = await context.params;
    parseOrThrow(aiDraftIdParamSchema, { draftId });

    const cancelled = await getConfirmAiDraftUseCase().cancel(session.userId, draftId);

    const { status, body } = toSuccessResponse(toCancelDto(cancelled), requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'ai_draft_cancel' },
);
