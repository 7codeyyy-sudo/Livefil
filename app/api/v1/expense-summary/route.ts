/**
 * `GET /api/v1/expense-summary`（EXP-004，《接口文档》§9）。
 *
 * 「同币种合并、跨币种分列不合计」（SRS FR-053、零混币合计）：响应里只有按币种
 * 分列的数组，没有任何跨币种单值字段——路由层不得为方便而补一个合计。
 */
import { NextResponse } from 'next/server';

import {
  summarizeExpensesQuerySchema,
  toExpenseSummaryDto,
} from '@/modules/expenses/application/expense-dto.ts';
import { ManageExpenseUseCase } from '@/modules/expenses/application/manage-expense.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { getAuditLogger, getRepositories } from '../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow } from '../../../_lib/validation.ts';

function useCase(): ManageExpenseUseCase {
  const repositories = getRepositories();
  return new ManageExpenseUseCase({
    expenses: repositories.expenses,
    expenseCategories: repositories.expenseCategories,
    lifeAreas: repositories.lifeAreas,
    goals: repositories.goals,
    actions: repositories.actions,
    audit: getAuditLogger(),
  });
}

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const query = parseOrThrow(
      summarizeExpensesQuerySchema,
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const summary = await useCase().summarize(session.userId, query);

    const { status, body } = toSuccessResponse(toExpenseSummaryDto(summary), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'expense_summary' },
);
