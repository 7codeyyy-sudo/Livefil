/**
 * `POST /api/v1/tasks/{taskId}/archive`（TASK-003，《接口文档》§4）。
 *
 * 归档是状态流转（`→ archived`）的一种，走 `/status` 同一条领域路径；
 * 单独成端点是因为它是收件箱三动作之一（UI v0.19 §5），调用频率与语义都独立。
 * 从归档恢复走流转矩阵的 `archived → inbox/planned`（恢复入口 UI 挂后续批次）。
 */
import { NextResponse } from 'next/server';

import { ManageTaskUseCase } from '@/modules/tasks/application/manage-task.ts';
import { toTaskDto } from '@/modules/tasks/application/task-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { withIdempotency } from '../../../../../_lib/idempotency.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';
import { readJsonBody } from '../../../../../_lib/validation.ts';
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

    // 无请求体的端点：指纹用 null（幂等编排允许无负载请求）。
    let payload: unknown = null;
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null && contentLength !== '0') {
      payload = await readJsonBody(request);
    }

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const archived = await useCase().archive(session.userId, taskId, requestId);
        return toSuccessResponse(toTaskDto(archived), requestId);
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'task_archive' },
);
