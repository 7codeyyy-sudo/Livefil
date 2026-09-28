/**
 * `POST /api/v1/expenses/{expenseId}/restore`（撤销软删，EXP-002 / FR-052）。
 *
 * A4 第 3 步的落地：撤销 Toast 点击后清 `deleted_at`，带 `version` 做乐观并发
 * （撤销与编辑可能同时发生，无条件恢复会覆盖用户刚做的编辑）。窗口只有 8s，
 * 因此这里不引入额外的幂等编排——重复点击由 `version` 与"必须处于已删状态"收敛。
 */
import { NextResponse } from 'next/server';

import { ManageExpenseUseCase } from '@/modules/expenses/application/manage-expense.ts';
import { restoreExpenseSchema, toExpenseDto } from '@/modules/expenses/application/expense-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { getAuditLogger, getRepositories } from '../../../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../../_lib/validation.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
interface ExpenseRestoreRouteContext {
  readonly params: Promise<{ readonly expenseId: string }>;
}

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

export const POST = createApiRouteHandler<ExpenseRestoreRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { expenseId } = await context.params;

    const payload = parseOrThrow(restoreExpenseSchema, await readJsonBody(request));

    const restored = await useCase().restore(session.userId, expenseId, payload.version, requestId);

    const { status, body } = toSuccessResponse(toExpenseDto(restored), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'expense_restore' },
);
