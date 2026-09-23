/** `PUT /api/v1/recovery-mode`（EXEC-002，接口 §7：恢复模式手动态）。 */
import { NextResponse } from 'next/server';

import {
  ManageRecoveryModeUseCase,
  setRecoveryModeSchema,
} from '@/modules/execution/application/manage-execution';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../_lib/validation.ts';
import { getAuditLogger, getRepositories } from '../../../../composition-root.ts';

export const PUT = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const payload = parseOrThrow(setRecoveryModeSchema, await readJsonBody(request));
    const useCase = new ManageRecoveryModeUseCase({
      recovery: getRepositories().recoveryStates,
      audit: getAuditLogger(),
    });
    const state = await useCase.set(session.userId, payload.enabled, requestId);
    const { status, body } = toSuccessResponse(state, requestId);
    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'recovery_mode_set' },
);
