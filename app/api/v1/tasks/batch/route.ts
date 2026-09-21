/**
 * `POST /api/v1/tasks/batch`（TASK-002/003，《接口文档》§4）。
 *
 * 批量安排 / 批量归档（UI v0.19 §5 收件箱多选的两个批量动作）。核心承诺：
 * **单事务、整批失败**——任一条不合法（不存在 / 非本人 / 流转非法）则整批回滚，
 * 不产生部分写入；`≤100` 条的上限由请求 schema 强制。
 */
import { NextResponse } from 'next/server';

import { ManageTaskUseCase } from '@/modules/tasks/application/manage-task.ts';
import { batchTasksSchema, toTaskDto } from '@/modules/tasks/application/task-dto.ts';
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

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const payload = parseOrThrow(batchTasksSchema, await readJsonBody(request));

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const updated = await useCase().batch(
          session.userId,
          payload.taskIds,
          payload.operation,
          {
            dueDate: payload.dueDate ?? null,
            lifeAreaId: payload.lifeAreaId ?? null,
          },
          requestId,
        );
        return toSuccessResponse({ items: updated.map(toTaskDto) }, requestId);
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'task_batch' },
);
