/**
 * `POST /api/v1/tasks/{taskId}/status`（TASK-003，《接口文档》§4）。
 *
 * 流转合法性由领域流转表判定（DB §4.5，表外一律 `VALIDATION_ERROR`）；
 * `reasonCode` / `note` / `actualMinutes` / `actualAmount` 不进任务行，
 * 随状态事件走 `audit` 通道（`execution_logs` 自 Phase 4 才接入）。
 */
import { NextResponse } from 'next/server';

import { ManageTaskUseCase } from '@/modules/tasks/application/manage-task.ts';
import { taskStatusChangeSchema, toTaskDto } from '@/modules/tasks/application/task-dto.ts';
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

    const payload = parseOrThrow(taskStatusChangeSchema, await readJsonBody(request));

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const updated = await useCase().changeStatus(
          session.userId,
          taskId,
          {
            to: payload.status,
            reasonCode: payload.reasonCode ?? null,
            note: payload.note ?? null,
            actualMinutes: payload.actualMinutes ?? null,
            actualAmount: payload.actualAmount ?? null,
          },
          requestId,
        );
        return toSuccessResponse(toTaskDto(updated), requestId);
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'task_status_change' },
);
