/** `GET /api/v1/today`（UI-007 / FR-030 的一屏聚合，接口 §6）。 */
import { NextResponse } from 'next/server';

import { resolveTodayTimeZone } from '@/modules/scheduling/application/resolve-today-timezone';
import { buildTodayView, todayQuerySchema } from '@/modules/scheduling/application/today-view';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow } from '../../../_lib/validation.ts';
import { getRepositories } from '../../../../composition-root.ts';

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const query = parseOrThrow(todayQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
    const repositories = getRepositories();
    // 客户端时区只当提示：非法时回落用户档案时区，避免裸 RangeError 变成 500。
    const timezone = await resolveTodayTimeZone(query.timezone, async () => {
      const profile = await repositories.users.findById(session.userId);
      return profile?.settings.timezone ?? null;
    });
    const view = await buildTodayView(session.userId, { ...query, timezone }, new Date(), {
      blocks: repositories.scheduleBlocks,
      fixed: repositories.fixedCommitments,
      tasks: repositories.tasks,
      goals: repositories.goals,
      actions: repositories.actions,
      routines: repositories.routines,
      logs: repositories.executionLogs,
      recovery: repositories.recoveryStates,
    });
    const { status, body } = toSuccessResponse(view, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'today_view' },
);
