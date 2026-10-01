/**
 * `POST /api/v1/ai/drafts/expense-parse`（AI-006，《接口文档》§11）。
 *
 * `amountMinor` 为**整数分**；生成只是草稿，写入正式开销由 confirm 完成
 * （FR-082「金额写入前必须确认」）。系统指令带 FR-083 的四类禁区约束。
 */
import { NextResponse } from 'next/server';

import {
  expenseParseRequestSchema,
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

    const payload = parseOrThrow(expenseParseRequestSchema, await readJsonBody(request));
    const draft = await getGenerateAiDraftUseCase().generateExpenseParse(session.userId, payload);

    const { status, body } = toSuccessResponse(toAiDraftResponseDto(draft), requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'ai_draft_expense_parse' },
);
