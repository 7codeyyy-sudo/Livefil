/**
 * `POST /api/v1/life-areas/reorder`（IAM-003，《接口文档》§3）。
 *
 * 单独一个端点而不是"多次 PATCH"：多次 PATCH 会产生中间态——排到一半失败时
 * `sort_order` 处于重复或缺口状态，而排序的唯一依据就是它。批量重排在单事务内
 * 完成，"全部成功或全部不变"。
 *
 * 路径段 `reorder` 是静态的，Next 的路由优先级保证它不会被同层的
 * `[lifeAreaId]` 动态段吃掉。
 */
import { NextResponse } from 'next/server';

import { ManageLifeAreaUseCase } from '@/modules/life-areas/application/manage-life-area.ts';
import {
  reorderLifeAreasSchema,
  toLifeAreaDto,
} from '@/modules/life-areas/application/life-area-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { getAuditLogger, getRepositories } from '../../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../_lib/validation.ts';

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const payload = parseOrThrow(reorderLifeAreasSchema, await readJsonBody(request));

    const useCase = new ManageLifeAreaUseCase({
      lifeAreas: getRepositories().lifeAreas,
      audit: getAuditLogger(),
    });
    const reordered = await useCase.reorder(session.userId, payload.orderedIds, requestId);

    const { status, body } = toSuccessResponse({ items: reordered.map(toLifeAreaDto) }, requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'life_area_reorder' },
);
