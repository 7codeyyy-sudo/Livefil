/**
 * `PATCH /api/v1/expense-categories/{categoryId}`（重命名 / 停用 / 恢复）
 * （EXP-001，《接口文档》§9）。
 *
 * **刻意不提供 `DELETE`**（A6 明文）：SRS FR-051 的删除语义就是"停用不删历史开销"，
 * 物理删除会让"这笔开销当初算在哪一类"永远无法回答。停用只置 `is_archived`，
 * 历史开销的关联保持可解析。
 */
import { NextResponse } from 'next/server';

import { ManageExpenseCategoryUseCase } from '@/modules/expenses/application/manage-expense-category.ts';
import {
  toExpenseCategoryDto,
  updateExpenseCategorySchema,
} from '@/modules/expenses/application/expense-category-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { getAuditLogger, getRepositories } from '../../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../_lib/validation.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
interface ExpenseCategoryRouteContext {
  readonly params: Promise<{ readonly categoryId: string }>;
}

function useCase(): ManageExpenseCategoryUseCase {
  return new ManageExpenseCategoryUseCase({
    expenseCategories: getRepositories().expenseCategories,
    audit: getAuditLogger(),
  });
}

export const PATCH = createApiRouteHandler<ExpenseCategoryRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { categoryId } = await context.params;

    const payload = parseOrThrow(updateExpenseCategorySchema, await readJsonBody(request));
    const updated = await useCase().update(session.userId, categoryId, payload, requestId);

    const { status, body } = toSuccessResponse(toExpenseCategoryDto(updated), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'expense_category_update' },
);
