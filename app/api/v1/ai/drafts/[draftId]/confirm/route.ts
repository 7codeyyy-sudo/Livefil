/**
 * `POST /api/v1/ai/drafts/{draftId}/confirm`（AI-004/005/006，《接口文档》§11）。
 *
 * 确认后**由既有普通用例**写入正式数据（任务 / 时间块 / 开销）；请求体可选
 * （形状见 `ai-draft-dto.ts` 的 `aiDraftConfirmBodySchema`）：确认开销草稿时必须
 * 给出用户选定的分类，其余类型可省略整个请求体。
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  aiDraftConfirmBodySchema,
  aiDraftIdParamSchema,
  toConfirmDto,
  type AiDraftConfirmBody,
} from '@/modules/ai/application/ai-draft-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { ValidationError } from '@/shared/errors/app-error.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../../../_lib/session-api.ts';
import { parseOrThrow } from '../../../../../../_lib/validation.ts';
import { getConfirmAiDraftUseCase } from '../../../../../../../composition-root.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
interface AiDraftRouteContext {
  readonly params: Promise<{ readonly draftId: string }>;
}

/**
 * 读取可省略的请求体。
 *
 * 与 `readJsonBody` 的差别只有一处：空体视为 `{}` 而不是非法 JSON——confirm 允许
 * 不带体的请求（非开销草稿），用 `request.json()` 会把「没有体」误判成 400。
 */
async function readOptionalConfirmBody(request: NextRequest): Promise<AiDraftConfirmBody> {
  const raw = await request.text();
  if (raw.trim() === '') {
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ValidationError('请求体不是合法的 JSON');
  }
  return parseOrThrow(aiDraftConfirmBodySchema, json);
}

export const POST = createApiRouteHandler<AiDraftRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { draftId } = await context.params;
    parseOrThrow(aiDraftIdParamSchema, { draftId });

    const body = await readOptionalConfirmBody(request);
    const result = await getConfirmAiDraftUseCase().confirm(
      session.userId,
      draftId,
      body,
      requestId,
    );

    const { status, body: responseBody } = toSuccessResponse(toConfirmDto(result), requestId);
    return withSessionCookie(NextResponse.json(responseBody, { status }), session);
  },
  { operation: 'ai_draft_confirm' },
);
