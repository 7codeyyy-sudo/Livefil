/**
 * `POST /api/v1/tasks/{taskId}/convert-to-action`（GOAL-002，《接口文档》§4）。
 *
 * 「转为目标行动」：在指定目标下创建行动并回填任务关联（goalId/actionId），
 * 任务保留、状态进入已安排。跨两个聚合的编排细节见 `ManageTaskUseCase.convertToAction`。
 */
import { NextResponse } from 'next/server';

import { ManageTaskUseCase } from '@/modules/tasks/application/manage-task.ts';
import { convertToActionSchema, toTaskDto } from '@/modules/tasks/application/task-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { withIdempotency } from '../../../../../_lib/idempotency.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../../_lib/validation.ts';
import {
  getAuditLogger,
  getIdempotencyStore,
  getRepositories,
} from '../../../../../../composition-root.ts';

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

function useCase(): ManageTaskUseCase {
  const repositories = getRepositories();
  return new ManageTaskUseCase({
    tasks: repositories.tasks,
    goals: repositories.goals,
    actions: repositories.actions,
    lifeAreas: repositories.lifeAreas,
    audit: getAuditLogger(),
  });
}

export const POST = createApiRouteHandler<TaskRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { taskId } = await context.params;

    const payload = parseOrThrow(convertToActionSchema, await readJsonBody(request));

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const { task } = await useCase().convertToAction(
          session.userId,
          taskId,
          {
            goalId: payload.goalId,
            name: payload.name ?? null,
            minimumVersion: payload.minimumVersion ?? null,
            estimatedMinutes: payload.estimatedMinutes ?? null,
          },
          requestId,
        );
        return toSuccessResponse(toTaskDto(task), requestId);
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'task_convert_to_action' },
);
