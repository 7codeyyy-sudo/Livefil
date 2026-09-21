/**
 * `PATCH / DELETE /api/v1/actions/{actionId}`（GOAL-002，《接口文档》§5）。
 *
 * `PATCH` 更新状态 / 频率 / 最低版本 / 预计时长（必带 `version`）；
 * `DELETE` 软删——有关联任务时同一事务把任务的 `actionId` 置空（`goalId`
 * 保留、任务不删，DB §4.4）；重复删除与不存在同义：404。
 */
import { NextResponse } from 'next/server';

import { ManageGoalUseCase } from '@/modules/goals/application/manage-goal.ts';
import { toActionDto, updateActionSchema } from '@/modules/goals/application/goal-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { withIdempotency } from '../../../../_lib/idempotency.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../_lib/validation.ts';
import {
  getAuditLogger,
  getIdempotencyStore,
  getRepositories,
} from '../../../../../composition-root.ts';

interface ActionRouteContext {
  readonly params: Promise<{ readonly actionId: string }>;
}

function useCase(): ManageGoalUseCase {
  const repositories = getRepositories();
  return new ManageGoalUseCase({
    goals: repositories.goals,
    actions: repositories.actions,
    lifeAreas: repositories.lifeAreas,
    audit: getAuditLogger(),
  });
}

export const PATCH = createApiRouteHandler<ActionRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { actionId } = await context.params;

    const payload = parseOrThrow(updateActionSchema, await readJsonBody(request));
    const { version, ...patch } = payload;

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const updated = await useCase().updateAction(
          session.userId,
          actionId,
          version,
          patch,
          requestId,
        );
        return toSuccessResponse(toActionDto(updated), requestId);
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'action_update' },
);

export const DELETE = createApiRouteHandler<ActionRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { actionId } = await context.params;

    const result = await withIdempotency(
      request,
      session.userId,
      null,
      getIdempotencyStore(),
      async () => {
        await useCase().deleteAction(session.userId, actionId, requestId);
        // 软删成功没有实体可返回：`data: null`（§1.2 与 UI-004 确立的空语义）。
        return toSuccessResponse(null, requestId);
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'action_delete' },
);
