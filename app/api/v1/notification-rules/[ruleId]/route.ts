/**
 * `PATCH /api/v1/notification-rules/{ruleId}`（更新）与
 * `DELETE /api/v1/notification-rules/{ruleId}`（硬删）（NOTIFY-001，《接口文档》§16）。
 *
 * - `PATCH` 可改 `remindAt` / `repeatRule` / `allowQuietHours` / `enabled`；**单条关闭**
 *   即 `{"enabled": false}`（FR-070 第 4 项）。`level` 不在可改字段内。
 * - `DELETE` 为**硬删**：已生成的交付记录保留（`rule_id` 经 `ON DELETE SET NULL` 置空）。
 * - 非本人或不存在 → `NOT_FOUND`（404，**不复用 403**，避免泄露存在性）。
 */
import { NextResponse } from 'next/server';

import { ManageNotificationRuleUseCase } from '@/modules/notifications/application/manage-notification-rule.ts';
import {
  toNotificationRuleDto,
  updateNotificationRuleSchema,
} from '@/modules/notifications/application/notification-rule-dto.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../_lib/api-route.ts';
import { getAuditLogger, getRepositories } from '../../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../_lib/validation.ts';

/** App Router 的动态段参数（Next 15 起 `params` 是 Promise）。 */
interface NotificationRuleRouteContext {
  readonly params: Promise<{ readonly ruleId: string }>;
}

function useCase(): ManageNotificationRuleUseCase {
  const repositories = getRepositories();
  return new ManageNotificationRuleUseCase({
    notificationRules: repositories.notificationRules,
    tasks: repositories.tasks,
    routines: repositories.routines,
    audit: getAuditLogger(),
  });
}

export const PATCH = createApiRouteHandler<NotificationRuleRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { ruleId } = await context.params;

    const patch = parseOrThrow(updateNotificationRuleSchema, await readJsonBody(request));
    const updated = await useCase().update(session.userId, ruleId, patch, requestId);

    const { status, body } = toSuccessResponse(toNotificationRuleDto(updated), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'notification_rule_update' },
);

export const DELETE = createApiRouteHandler<NotificationRuleRouteContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { ruleId } = await context.params;

    await useCase().delete(session.userId, ruleId, requestId);

    const { status, body } = toSuccessResponse({ ruleId }, requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'notification_rule_delete' },
);
