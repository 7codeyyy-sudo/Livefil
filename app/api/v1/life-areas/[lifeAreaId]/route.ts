/**
 * `PATCH /api/v1/life-areas/{lifeAreaId}` 与 `DELETE /api/v1/life-areas/{lifeAreaId}`
 * （IAM-003，《接口文档》§3）。
 *
 * ## `DELETE` 的语义是**归档**，不是删除
 *
 * 契约里写得很明确：「语义＝归档（置 is_archived），不删除历史任务、目标和开销关联」。
 * 所以这个端点内部调用的就是 `update({ isArchived: true })`，与 PATCH 走同一条
 * 代码路径——分成两套实现迟早会出现"PATCH 归档时做了审计、DELETE 归档时忘了"。
 */
import { NextResponse } from 'next/server';

import { ManageLifeAreaUseCase } from '@/modules/life-areas/application/manage-life-area.ts';
import {
  toLifeAreaDto,
  updateLifeAreaSchema,
} from '@/modules/life-areas/application/life-area-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { getAuditLogger, getRepositories } from '../../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../_lib/validation.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
interface LifeAreaRouteContext {
  readonly params: Promise<{ readonly lifeAreaId: string }>;
}

function useCase(): ManageLifeAreaUseCase {
  return new ManageLifeAreaUseCase({
    lifeAreas: getRepositories().lifeAreas,
    audit: getAuditLogger(),
  });
}

export const PATCH = createApiRouteHandler<LifeAreaRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { lifeAreaId } = await context.params;

    const payload = parseOrThrow(updateLifeAreaSchema, await readJsonBody(request));
    const updated = await useCase().update(session.userId, lifeAreaId, payload, requestId);

    const { status, body } = toSuccessResponse(toLifeAreaDto(updated), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'life_area_update' },
);

export const DELETE = createApiRouteHandler<LifeAreaRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { lifeAreaId } = await context.params;

    const archived = await useCase().update(
      session.userId,
      lifeAreaId,
      { isArchived: true },
      requestId,
    );

    const { status, body } = toSuccessResponse(toLifeAreaDto(archived), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'life_area_archive' },
);
