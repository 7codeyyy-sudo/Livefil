/**
 * `GET / PATCH / DELETE /api/v1/tasks/{taskId}`（TASK-002/003，《接口文档》§4）。
 *
 * - `PATCH` 必带 `version`（乐观并发，冲突返回 409）；
 * - `DELETE` 的语义是**软删**（置 `deleted_at`）：已删任务不出现在任何查询中，
 *   因此对同一个 id 的第二次 DELETE 与"任务不存在"不可区分——统一 404，
 *   删除天然幂等。
 */
import { NextResponse } from 'next/server';

import { ManageTaskUseCase } from '@/modules/tasks/application/manage-task.ts';
import { toTaskDto, updateTaskSchema } from '@/modules/tasks/application/task-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../_lib/validation.ts';
import { getAuditLogger, getRepositories } from '../../../../../composition-root.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
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

export const GET = createApiRouteHandler<TaskRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { taskId } = await context.params;

    const task = await useCase().findById(session.userId, taskId);

    const { status, body } = toSuccessResponse(toTaskDto(task), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'task_get' },
);

export const PATCH = createApiRouteHandler<TaskRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { taskId } = await context.params;

    const payload = parseOrThrow(updateTaskSchema, await readJsonBody(request));
    const { version, ...patch } = payload;
    const updated = await useCase().update(session.userId, taskId, version, patch, requestId);

    const { status, body } = toSuccessResponse(toTaskDto(updated), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'task_update' },
);

export const DELETE = createApiRouteHandler<TaskRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { taskId } = await context.params;

    await useCase().delete(session.userId, taskId, requestId);

    // 软删成功没有实体可返回：`data: null`（§1.2 与 UI-004 确立的空语义）。
    const { status, body } = toSuccessResponse(null, requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'task_delete' },
);
