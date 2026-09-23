/**
 * `GET /api/v1/tasks`（收件箱/列表）与 `POST /api/v1/tasks`（创建）
 * （TASK-002/003，《接口文档》§4）。
 *
 * 收件箱的查询口径（UI 规范 v0.19 §5 冻结）：`?status=inbox`——任务被安排
 * （→ planned）或归档（→ archived）后即离开收件箱，不做"显示全部未归档"。
 */
import { NextResponse } from 'next/server';

import { ManageTaskUseCase } from '@/modules/tasks/application/manage-task.ts';
import { materializeRecurringTasks } from '@/modules/scheduling/application/materialize';
import {
  createTaskSchema,
  listTasksQuerySchema,
  toTaskDto,
} from '@/modules/tasks/application/task-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { withIdempotency } from '../../../_lib/idempotency.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../_lib/validation.ts';
import {
  getAuditLogger,
  getIdempotencyStore,
  getRepositories,
} from '../../../../composition-root.ts';

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

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const query = parseOrThrow(
      listTasksQuerySchema,
      Object.fromEntries(request.nextUrl.searchParams),
    );
    // DB §4.5 冻结：from/to 窗口查询触发重复任务物化（幂等靠唯一约束）。
    if (typeof query.from === 'string' && typeof query.to === 'string') {
      await materializeRecurringTasks(
        session.userId,
        query.from,
        query.to,
        getRepositories().tasks,
      );
    }
    const page = await useCase().list(session.userId, query);

    const { status, body } = toSuccessResponse(
      { items: page.items.map(toTaskDto) },
      requestId,
      new Date(),
      // 分页游标在 `meta`（§1.3），客户端的「加载更多」只看这两个字段。
      { nextCursor: page.nextCursor, hasMore: page.hasMore },
    );

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'task_list' },
);

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const payload = parseOrThrow(createTaskSchema, await readJsonBody(request));

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const created = await useCase().create(
          session.userId,
          {
            title: payload.title,
            status: payload.status,
            lifeAreaId: payload.lifeAreaId ?? null,
            dueDate: payload.dueDate ?? null,
            estimatedMinutes: payload.estimatedMinutes ?? null,
            minimumVersion: payload.minimumVersion ?? null,
            goalId: payload.goalId ?? null,
            actionId: payload.actionId ?? null,
          },
          requestId,
        );
        return toSuccessResponse(toTaskDto(created), requestId);
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'task_create' },
);
