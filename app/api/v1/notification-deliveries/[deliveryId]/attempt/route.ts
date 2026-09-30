/**
 * `POST /api/v1/notification-deliveries/{deliveryId}/attempt`（触达尝试结果上报，
 * v0.7 第 8 端点，《接口文档》§16）。
 *
 * 客户端只报两个事实字段（`outcome` + `errorCode`）；服务端派生 `status` /
 * `attempt_count` / `last_attempt_at` / `next_retry_at` / `channel` 并回带。
 *
 * - 终态行（`sent` / `cancelled`）或已达重试上限的 `failed` 行 → 409 `CONFLICT`；
 * - 非本人或不存在 → 404 `NOT_FOUND`（不复用 403）；
 * - 携带 `Idempotency-Key` 时经既有幂等编排识别重复上报（`IDEMPOTENCY_REPLAY` 409，
 *   不二次递增 `attempt_count`）。客户端纪律：**一次尝试一个 key**。
 */
import { NextResponse } from 'next/server';

import { ManageNotificationDeliveryUseCase } from '@/modules/notifications/application/manage-notification-delivery.ts';
import {
  reportNotificationAttemptSchema,
  toNotificationAttemptResultDto,
} from '@/modules/notifications/application/notification-delivery-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { withIdempotency } from '../../../../../_lib/idempotency.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../../_lib/validation.ts';
import {
  getAuditLogger,
  getIdempotencyStore,
  getRepositories,
} from '../../../../../../composition-root.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
interface NotificationAttemptRouteContext {
  readonly params: Promise<{ readonly deliveryId: string }>;
}

function useCase(): ManageNotificationDeliveryUseCase {
  const repositories = getRepositories();
  return new ManageNotificationDeliveryUseCase({
    notificationDeliveries: repositories.notificationDeliveries,
    audit: getAuditLogger(),
  });
}

export const POST = createApiRouteHandler<NotificationAttemptRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { deliveryId } = await context.params;

    const payload = parseOrThrow(reportNotificationAttemptSchema, await readJsonBody(request));

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const reported = await useCase().reportAttempt(
          session.userId,
          deliveryId,
          { outcome: payload.outcome, errorCode: payload.errorCode ?? null },
          new Date(),
          undefined,
          requestId,
        );
        return toSuccessResponse(toNotificationAttemptResultDto(reported), requestId);
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'notification_attempt_report' },
);
