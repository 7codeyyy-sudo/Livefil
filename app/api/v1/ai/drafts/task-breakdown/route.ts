/**
 * `POST /api/v1/ai/drafts/task-breakdown`（AI-004，《接口文档》§11）。
 *
 * 请求体 → Zod（`.strict()`）校验 → 生成用例（脱敏 → 调用 → 校验 → 落草稿）→
 * §1.2 成功包络。响应里的 `suggestions` 在生成失败（`status='failed'`）时为空集，
 * 与 §1.3「失败按 200 返回空 suggestions」一致——不因生成失败而改状态码。
 */
import { NextResponse } from 'next/server';

import {
  taskBreakdownRequestSchema,
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

    const payload = parseOrThrow(taskBreakdownRequestSchema, await readJsonBody(request));
    const draft = await getGenerateAiDraftUseCase().generateTaskBreakdown(session.userId, payload);

    const { status, body } = toSuccessResponse(toAiDraftResponseDto(draft), requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'ai_draft_task_breakdown' },
);
