/**
 * `POST /api/v1/notifications/{deliveryId}/dismiss`（NOTIFY-002，《接口文档》§16）。
 *
 * 用户「已处理」出口：写 `dismissed_at`，**不改 `status`**（状态枚举保持四值不变）。
 * 重复 dismiss 幂等（200）。非本人或不存在 → `NOT_FOUND`（404，不复用 403）。
 */
import { NextResponse } from 'next/server';

import { ManageNotificationDeliveryUseCase } from '@/modules/notifications/application/manage-notification-delivery.ts';
import { toNotificationDeliveryDto } from '@/modules/notifications/application/notification-delivery-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { getAuditLogger, getRepositories } from '../../../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
interface NotificationDismissRouteContext {
  readonly params: Promise<{ readonly deliveryId: string }>;
}

function useCase(): ManageNotificationDeliveryUseCase {
  const repositories = getRepositories();
  return new ManageNotificationDeliveryUseCase({
    notificationDeliveries: repositories.notificationDeliveries,
    audit: getAuditLogger(),
  });
}

export const POST = createApiRouteHandler<NotificationDismissRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { deliveryId } = await context.params;

    const dismissed = await useCase().dismiss(session.userId, deliveryId, new Date(), requestId);

    const { status, body } = toSuccessResponse(toNotificationDeliveryDto(dismissed), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'notification_dismiss' },
);
