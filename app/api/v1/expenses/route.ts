/**
 * `GET /api/v1/expenses`（列表）与 `POST /api/v1/expenses`（记一笔）
 * （EXP-002/003，《接口文档》§9）。
 *
 * 排序与分页口径固定在仓储侧（`occurred_on desc, created_at desc` + 不透明游标），
 * 路由只把 `meta.nextCursor` / `hasMore` 透出去——「加载更多」只看这两个字段。
 */
import { NextResponse } from 'next/server';

import { ManageExpenseUseCase } from '@/modules/expenses/application/manage-expense.ts';
import {
  createExpenseSchema,
  listExpensesQuerySchema,
  toExpenseDto,
} from '@/modules/expenses/application/expense-dto.ts';
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
      listExpensesQuerySchema,
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const page = await useCase().list(session.userId, query);

    const { status, body } = toSuccessResponse(
      { items: page.items.map(toExpenseDto) },
      requestId,
      new Date(),
      { nextCursor: page.nextCursor, hasMore: page.hasMore },
    );

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'expense_list' },
);

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const payload = parseOrThrow(createExpenseSchema, await readJsonBody(request));

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const created = await useCase().create(
          session.userId,
          {
            categoryId: payload.categoryId,
            lifeAreaId: payload.lifeAreaId ?? null,
            goalId: payload.goalId ?? null,
            actionId: payload.actionId ?? null,
            amountMinor: payload.amountMinor,
            currencyCode: payload.currencyCode,
            occurredOn: payload.occurredOn,
            paymentMethod: payload.paymentMethod ?? null,
            note: payload.note ?? null,
            source: payload.source,
          },
          requestId,
        );
        return toSuccessResponse(toExpenseDto(created), requestId);
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'expense_create' },
);
