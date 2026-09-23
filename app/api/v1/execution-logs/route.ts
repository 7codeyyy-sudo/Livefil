/** `POST / GET /api/v1/execution-logs`（EXEC-001，接口 §7）。 */
import { NextResponse } from 'next/server';

import {
  RecordExecutionUseCase,
  createExecutionLogSchema,
  listExecutionLogsQuerySchema,
  resolveUtcWindow,
} from '@/modules/execution/application/manage-execution';
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

function useCase(): RecordExecutionUseCase {
  const repositories = getRepositories();
  return new RecordExecutionUseCase({
    logs: repositories.executionLogs,
    blocks: repositories.scheduleBlocks,
    tasks: repositories.tasks,
    audit: getAuditLogger(),
  });
}

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const payload = parseOrThrow(createExecutionLogSchema, await readJsonBody(request));
    // §7 冻结：执行记录**必须**携带 Idempotency-Key（追加式历史，重复提交
    // 靠重放挡）；缺失按 400 处理。
    if (request.headers.get('Idempotency-Key') === null) {
      const { status, body } = toErrorResponseMissingKey(requestId);
      return NextResponse.json(body, { status });
    }
    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const log = await useCase().create(session.userId, payload, requestId);
        return toSuccessResponse({ ...log, occurredAt: log.occurredAt.toISOString() }, requestId);
      },
    );
    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'execution_log_create' },
);

function toErrorResponseMissingKey(requestId: string): {
  status: number;
  body: unknown;
} {
  return {
    status: 400,
    body: {
      error: {
        code: 'VALIDATION_ERROR',
        message: '执行记录必须携带 Idempotency-Key 请求头',
        requestId,
      },
    },
  };
}

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const query = parseOrThrow(
      listExecutionLogsQuerySchema,
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (query.to < query.from || query.to > addDays(query.from, 91)) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: '查询窗口为空或超过 92 天上限',
            requestId,
          },
        },
        { status: 400 },
      );
    }
    // from/to 是用户时区的日历日——按 timezone 切 UTC 窗口（次要 11 审查修正）。
    const { fromUtc, toUtc } = resolveUtcWindow(query.from, query.to, query.timezone);
    const page = await useCase().list(session.userId, {
      fromUtc,
      toUtc,
      ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
      ...(query.actionId === undefined ? {} : { actionId: query.actionId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: query.limit,
    });
    const { status, body } = toSuccessResponse(
      {
        items: page.items.map((log) => ({
          ...log,
          occurredAt: log.occurredAt.toISOString(),
        })),
      },
      requestId,
      new Date(),
      { nextCursor: page.nextCursor, hasMore: page.hasMore },
    );
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'execution_log_list' },
);

function addDays(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}
