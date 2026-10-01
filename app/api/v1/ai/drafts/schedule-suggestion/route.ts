/**
 * `POST /api/v1/ai/drafts/schedule-suggestion`（AI-005，《接口文档》§11）。
 *
 * 只把请求体 `taskIds` 指定且属于当前用户的任务交给模型；`reason` 是每条建议的
 * 必填项（FR-081「可解释建议」，schema 强制），确认时按 `source='suggested'` 落时间块。
 */
import { NextResponse } from 'next/server';

import {
  scheduleSuggestionRequestSchema,
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

    const payload = parseOrThrow(scheduleSuggestionRequestSchema, await readJsonBody(request));
    const draft = await getGenerateAiDraftUseCase().generateScheduleSuggestion(
      session.userId,
      payload,
    );

    const { status, body } = toSuccessResponse(toAiDraftResponseDto(draft), requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'ai_draft_schedule_suggestion' },
);
