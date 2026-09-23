/** `GET/POST /api/v1/schedule-blocks`（SCHED-001/002，接口 §6）。 */
import { NextResponse } from 'next/server';

import {
  ManageScheduleBlockUseCase,
  blockWindowQuerySchema,
  createScheduleBlockSchema,
} from '@/modules/scheduling/application/manage-scheduling';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow } from '../../../_lib/validation.ts';
import { getAuditLogger, getRepositories } from '../../../../composition-root.ts';

function useCase(): ManageScheduleBlockUseCase {
  const repositories = getRepositories();
  return new ManageScheduleBlockUseCase({
    blocks: repositories.scheduleBlocks,
    fixed: repositories.fixedCommitments,
    tasks: repositories.tasks,
    audit: getAuditLogger(),
  });
}

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const query = parseOrThrow(
      blockWindowQuerySchema,
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const blocks = await useCase().listWindow(session.userId, query);
    // 阻塞 5（审查）：周网格/时间线需要标题——任务块取任务名、例程块取步骤名。
    const taskIds = blocks.map((b) => b.taskId).filter((id): id is string => id !== null);
    const repositories = getRepositories();
    const tasksById = new Map(
      (await repositories.tasks.findByIds(session.userId, taskIds)).map((t) => [t.id, t]),
    );
    const stepTitles = new Map<string, string>();
    for (const detail of await repositories.routines.listAll(session.userId)) {
      for (const step of detail.steps) stepTitles.set(step.id, step.title);
    }
    const items = blocks.map((block) => ({
      ...block,
      startsAtUtc: block.startsAtUtc.toISOString(),
      endsAtUtc: block.endsAtUtc.toISOString(),
      title:
        block.taskId !== null
          ? (tasksById.get(block.taskId)?.title ?? null)
          : block.routineStepId !== null
            ? (stepTitles.get(block.routineStepId) ?? null)
            : null,
    }));
    const { status, body } = toSuccessResponse({ items }, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'schedule_block_list' },
);

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const payload = parseOrThrow(createScheduleBlockSchema, await readBody(request));
    const result = await useCase().create(session.userId, payload, requestId);
    const { status, body } = toSuccessResponse(
      {
        ...result.block,
        startsAtUtc: result.block.startsAtUtc.toISOString(),
        endsAtUtc: result.block.endsAtUtc.toISOString(),
        conflictState: result.conflictState,
        conflicts: result.conflicts,
      },
      requestId,
    );
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'schedule_block_create' },
);

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
