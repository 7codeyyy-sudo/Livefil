/**
 * `GET /api/v1/life-areas` 与 `POST /api/v1/life-areas`（IAM-003，《接口文档》§3）。
 */
import { NextResponse } from 'next/server';

import { ManageLifeAreaUseCase } from '@/modules/life-areas/application/manage-life-area.ts';
import { createLifeAreaSchema } from '@/modules/life-areas/application/life-area-dto.ts';
import { toLifeAreaDto } from '@/modules/life-areas/application/life-area-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { getAuditLogger, getRepositories } from '../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../_lib/validation.ts';

function useCase(): ManageLifeAreaUseCase {
  return new ManageLifeAreaUseCase({
    lifeAreas: getRepositories().lifeAreas,
    audit: getAuditLogger(),
  });
}

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    // 只把字面量 `true` 当开启：`?includeArchived=1`、`=yes` 之类的写法一律按默认值
    // 处理，而不是"非空即真"——后者会让一个拼错的参数名悄悄改变结果集。
    const includeArchived = request.nextUrl.searchParams.get('includeArchived') === 'true';

    const lifeAreas = await useCase().list(session.userId, includeArchived);
    const { status, body } = toSuccessResponse({ items: lifeAreas.map(toLifeAreaDto) }, requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'life_area_list' },
);

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const payload = parseOrThrow(createLifeAreaSchema, await readJsonBody(request));
    const created = await useCase().create(session.userId, payload, requestId);

    const { status, body } = toSuccessResponse(toLifeAreaDto(created), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'life_area_create' },
);
