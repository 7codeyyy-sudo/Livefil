/**
 * `GET /api/v1/expense-categories`（分类列表）与 `POST /api/v1/expense-categories`
 * （新增自定义分类）（EXP-001，《接口文档》§9）。
 *
 * 与 `/life-areas` 同构：GET 的 `includeArchived` 只认字面量 `true`（`?includeArchived=1`
 * 之类的写法按默认值处理，避免一个拼错的参数悄悄改变结果集），POST 不挂幂等编排——
 * 重复提交被"同用户未停用同名唯一"挡住并返回 409，不需要幂等表来兜第二道。
 *
 * 分类端点**不进同步白名单**（本批仅 `expense` / `review` 两同步实体），因此离线
 * 新建/停用分类不支持，按普通失败路径明确提示。
 */
import { NextResponse } from 'next/server';

import { ManageExpenseCategoryUseCase } from '@/modules/expenses/application/manage-expense-category.ts';
import {
  createExpenseCategorySchema,
  toExpenseCategoryDto,
} from '@/modules/expenses/application/expense-category-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { getAuditLogger, getRepositories } from '../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../_lib/validation.ts';

function useCase(): ManageExpenseCategoryUseCase {
  return new ManageExpenseCategoryUseCase({
    expenseCategories: getRepositories().expenseCategories,
    audit: getAuditLogger(),
  });
}

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const includeArchived = request.nextUrl.searchParams.get('includeArchived') === 'true';

    // 首次访问时仓储会惰性播种 9 个默认分类（口径见端口注释与 §9）。
    const categories = await useCase().list(session.userId, includeArchived);
    const { status, body } = toSuccessResponse(
      { items: categories.map(toExpenseCategoryDto) },
      requestId,
    );

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'expense_category_list' },
);

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const payload = parseOrThrow(createExpenseCategorySchema, await readJsonBody(request));
    const created = await useCase().create(session.userId, { name: payload.name }, requestId);

    const { status, body } = toSuccessResponse(toExpenseCategoryDto(created), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'expense_category_create' },
);
