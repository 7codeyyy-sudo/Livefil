/**
 * `GET /api/v1/notifications/pending`（NOTIFY-002，《接口文档》§16）。
 *
 * FR-071「通知失败时，应用内仍应显示待处理提醒」的载体。返回 `status ∈ {pending, failed}`
 * 且**未 dismiss** 的行，按等级降序（关键 > 普通 > 复盘）、`scheduledFor` 升序。
 *
 * ## 这是一次"读取即写"
 *
 * 冻结契约没有创建 delivery 的端点或定时任务，待处理行由**读时物化**产生：本端点在同一
 * 事务里先作废三类失效条目、再补落本次应触发的条目，然后返回列表。对客户端仍是普通 GET。
 *
 * `data` 是**裸数组**（§16 示例形状）；本端点不分页，`meta` 固定 `nextCursor: null` /
 * `hasMore: false`。
 */
import { NextResponse } from 'next/server';

import { ManageNotificationDeliveryUseCase } from '@/modules/notifications/application/manage-notification-delivery.ts';
import { toPendingNotificationDto } from '@/modules/notifications/application/notification-delivery-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { getAuditLogger, getRepositories } from '../../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';

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

    const pending = await useCase().listPending(session.userId, new Date());

    const { status, body } = toSuccessResponse(
      pending.map(toPendingNotificationDto),
      requestId,
      new Date(),
      { nextCursor: null, hasMore: false },
    );

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'notification_pending_list' },
);
