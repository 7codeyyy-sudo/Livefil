/**
 * `GET /api/v1/notification-deliveries`（失败与重试查询）（NOTIFY-002，《接口文档》§16）。
 *
 * 参数：`status`（可选）、`onlyRetryable`（可选布尔）、`cursor`、`limit`。
 * 排序固定 `scheduled_for desc`，游标不透明。`data` 是**裸数组**（§16 示例形状）。
 */
import { NextResponse } from 'next/server';

import { ManageNotificationDeliveryUseCase } from '@/modules/notifications/application/manage-notification-delivery.ts';
import {
  listNotificationDeliveriesQuerySchema,
  toNotificationDeliveryDto,
} from '@/modules/notifications/application/notification-delivery-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { getAuditLogger, getRepositories } from '../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow } from '../../../_lib/validation.ts';

function useCase(): ManageNotificationDeliveryUseCase {
  const repositories = getRepositories();
  return new ManageNotificationDeliveryUseCase({
    notificationDeliveries: repositories.notificationDeliveries,
    audit: getAuditLogger(),
  });
}

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const query = parseOrThrow(
      listNotificationDeliveriesQuerySchema,
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const page = await useCase().listByUser(session.userId, query);

    const { status, body } = toSuccessResponse(
      page.items.map(toNotificationDeliveryDto),
      requestId,
      new Date(),
      { nextCursor: page.nextCursor, hasMore: page.hasMore },
    );

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'notification_delivery_list' },
);
