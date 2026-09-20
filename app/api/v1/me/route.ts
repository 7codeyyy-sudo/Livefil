/**
 * `GET /api/v1/me` 与 `PATCH /api/v1/me`（IAM-001 / IAM-002，《接口文档》§2）。
 *
 * ## `GET` 的"无 Cookie 也返回 200"
 *
 * 这是本地模式最容易做错的一点：没有有效会话 Cookie 时**不是 401**，而是自动
 * 初始化（建用户 + 播种默认领域）并下发会话（§4.6）。理由很实际——本地单用户
 * 没有"登录"这个动作可做，返回 401 等于要求用户去做一件不存在的事。
 *
 * ## `PATCH` 的单事务语义
 *
 * 校验失败不落库、`version` 不符返回 409（§4.7）。跨字段约束（AI 同意）在用例层
 * 判定，因为它需要读到现状。
 */
import { NextResponse } from 'next/server';

import { UpdateUserSettingsUseCase } from '@/modules/identity/application/update-user-settings.ts';
import { toUserDto } from '@/modules/identity/application/user-dto.ts';
import { updateUserSettingsSchema } from '@/modules/identity/application/user-settings-schema.ts';
import { NotFoundError } from '@/shared/errors/app-error.ts';
import { toSuccessResponse } from '@/shared/errors/api-error-response.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';
import { getAuditLogger, getRepositories } from '../../../../composition-root.ts';
import { resolveSession, withSessionCookie } from '../../../_lib/session-api.ts';
import { parseOrThrow, readJsonBody } from '../../../_lib/validation.ts';

export const GET = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const user = await getRepositories().users.findById(session.userId);
    if (user === null) {
      // 上一行的 `resolveSession` 刚确保过用户存在，走到这里说明库在两次调用之间
      // 被改动（本机重建库时会发生）。明确报 404，不静默编一份设置。
      throw new NotFoundError('用户不存在');
    }

    const { status, body } = toSuccessResponse(toUserDto(user), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'me_get' },
);

export const PATCH = createApiRouteHandler(
  async (request): Promise<NextResponse> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const session = await resolveSession(request);

    const payload = parseOrThrow(updateUserSettingsSchema, await readJsonBody(request));

    const useCase = new UpdateUserSettingsUseCase({
      users: getRepositories().users,
      audit: getAuditLogger(),
    });
    const updated = await useCase.execute(session.userId, payload, requestId);

    const { status, body } = toSuccessResponse(toUserDto(updated), requestId);

    return withSessionCookie(NextResponse.json(body, { status }), session);
  },
  { operation: 'me_patch' },
);
