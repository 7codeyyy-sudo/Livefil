/**
 * `POST /api/v1/data-imports/{importId}/confirm`（OPS-002，《接口文档》§13；
 * FR-091「导入失败可回滚」的正身）。
 *
 * - `Idempotency-Key` **必带**（契约「§1.1 必带」）——占位/重放/失败释放经
 *   `withIdempotency` 既有编排（同 `execution-logs` 的必带口径）。
 * - merge 自然幂等；replace 须 `confirm:true`（schema 层 400，与 UI
 *   ConfirmDialog 双保险）；`compatible=false` 一律 400。
 * - 单事务落库，失败整笔回滚（用例抛错 → 幂等占位 `release` → 结构化 4xx/5xx）。
 * 限流 5 次/小时/用户（八定值）。
 */
import { NextResponse } from 'next/server';

import { confirmImportSchema } from '@/modules/data-management/application/data-schemas.ts';
import { ValidationError } from '@/shared/errors/app-error.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { createConfirmImportUseCase } from '../../../../../_lib/data-deps.ts';
import { withIdempotency } from '../../../../../_lib/idempotency.ts';
import { getIdempotencyStore } from '../../../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../../../_lib/validation.ts';

interface ConfirmContext {
  readonly params: Promise<{ readonly importId: string }>;
}

export const POST = createApiRouteHandler<ConfirmContext>(
  async (request, context): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);
    const { importId } = await context.params;

    const payload = parseOrThrow(confirmImportSchema, await readJsonBody(request));

    // 契约：confirm 的 Idempotency-Key 必带（§1.1）。缺键直接 400——
    // 「导入」是多行写入，没有幂等键的重试可能造成半新半旧的重复感知。
    if (request.headers.get('Idempotency-Key') === null) {
      throw new ValidationError('确认导入必须携带 Idempotency-Key 请求头');
    }

    const result = await withIdempotency(
      request,
      session.userId,
      payload,
      getIdempotencyStore(),
      async () => {
        const outcome = await createConfirmImportUseCase().execute(
          session.userId,
          importId,
          payload.mode,
        );
        return toSuccessResponse(outcome, requestId);
      },
    );

    return withSessionCookie(NextResponse.json(result.body, { status: result.status }), session);
  },
  { operation: 'data_import_confirm' },
);
