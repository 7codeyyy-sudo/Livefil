/**
 * `GET /api/v1/expenses/{expenseId}`（单条读取）、
 * `PATCH /api/v1/expenses/{expenseId}`（编辑）与
 * `DELETE /api/v1/expenses/{expenseId}`（软删，返回可撤销信息）
 * （EXP-002，《接口文档》§9）。
 *
 * `DELETE` 的语义是**软删**（置 `deleted_at`），撤销由 `POST .../restore` 承接
 * （A4 的撤销 Toast 与 8s 窗口）。
 *
 * `GET` 是**第 8 项随批勘误**（PD-20260928-009 预审勘误⑥）：A4 冻结的冲突处置是
 * 「复用 §4.9.2 浮层、两版并列」，而 409 的响应体按 §4.9.2 只带
 * code / message / requestId，不含服务端行。此前客户端退化为「从无筛选列表首页
 * 里把它找出来」，早于最近 100 笔的记录就取不到，只能给一句重新加载的降级文案
 * ——与详设「金额冲突必须提示」冲突。补上这条实体路径后，冲突处置可以按 id
 * 直取服务端那一行（含金额与 `version`），不必绕列表、也不再需要降级外壳。
 */
import { NextResponse } from 'next/server';

import { ManageExpenseUseCase } from '@/modules/expenses/application/manage-expense.ts';
import { toExpenseDto, updateExpenseSchema } from '@/modules/expenses/application/expense-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { getAuditLogger, getRepositories } from '../../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../_lib/validation.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
interface ExpenseRouteContext {
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

export const GET = createApiRouteHandler<ExpenseRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { expenseId } = await context.params;

    // 用例层 `findById`：不存在 / 已软删 / 非本人一律 404（不泄露存在性）。
    const expense = await useCase().findById(session.userId, expenseId);

    const { status, body } = toSuccessResponse(toExpenseDto(expense), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'expense_get' },
);

export const PATCH = createApiRouteHandler<ExpenseRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { expenseId } = await context.params;

    const payload = parseOrThrow(updateExpenseSchema, await readJsonBody(request));
    const { version, ...patch } = payload;

    const updated = await useCase().update(session.userId, expenseId, version, patch, requestId);

    const { status, body } = toSuccessResponse(toExpenseDto(updated), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'expense_update' },
);

export const DELETE = createApiRouteHandler<ExpenseRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { expenseId } = await context.params;

    const deleted = await useCase().delete(session.userId, expenseId, requestId);

    // 响应体即"可撤销信息"：`deletedAt` 与 `version`（撤销请求要带它）。
    const { status, body } = toSuccessResponse(toExpenseDto(deleted), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'expense_delete' },
);
