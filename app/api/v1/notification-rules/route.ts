/**
 * `GET /api/v1/notification-rules`（列表）与 `POST /api/v1/notification-rules`（创建）
 * （NOTIFY-001，《接口文档》§16）。
 *
 * `data` 是**裸数组**（§16 的示例形状），分页游标仍在 `meta` 里透出。
 * `POST` 按 §16 返回 **201**；注意本仓库既有 POST（tasks / routines / expenses）实际
 * 返回 200 而文档声明 201，那属既有契约-实现偏差，不在本单范围——本端点按其自身
 * 冻结文本（§16「响应（201）回带派生等级」）实现。
 */
import { NextResponse } from 'next/server';

import { ManageNotificationRuleUseCase } from '@/modules/notifications/application/manage-notification-rule.ts';
import {
  createNotificationRuleSchema,
  listNotificationRulesQuerySchema,
  toNotificationRuleDto,
} from '@/modules/notifications/application/notification-rule-dto.ts';
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

function useCase(): ManageNotificationRuleUseCase {
  const repositories = getRepositories();
  return new ManageNotificationRuleUseCase({
    notificationRules: repositories.notificationRules,
    tasks: repositories.tasks,
    routines: repositories.routines,
    audit: getAuditLogger(),
  });
}

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const query = parseOrThrow(
      listNotificationRulesQuerySchema,
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const page = await useCase().list(session.userId, query);

    const { status, body } = toSuccessResponse(
      page.items.map(toNotificationRuleDto),
      requestId,
      new Date(),
      { nextCursor: page.nextCursor, hasMore: page.hasMore },
    );

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'notification_rule_list' },
);

export const POST = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const payload = parseOrThrow(createNotificationRuleSchema, await readJsonBody(request));

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const created = await useCase().create(
          session.userId,
          {
            targetType: payload.targetType,
            targetId: payload.targetId ?? null,
            remindAt: payload.remindAt,
            repeatRule: payload.repeatRule,
            allowQuietHours: payload.allowQuietHours,
          },
          requestId,
        );
        // 201：§16 的创建响应码（`toSuccessResponse` 固定 200，这里显式覆盖状态）。
        const success = toSuccessResponse(toNotificationRuleDto(created), requestId);
        return { status: 201, body: success.body };
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'notification_rule_create' },
);
