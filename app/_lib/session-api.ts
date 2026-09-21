/**
 * 会话相关的端点助手（IAM-001）。
 *
 * 每个需要"当前用户"的端点都要做同样两件事：解析/建立会话、在需要时下发 Cookie。
 * 写两遍以上就有两个可能漂移的版本，而 Cookie 属性一旦漂移，表现是"某些接口
 * 建立得起会话、另一些建立不起"这类难查的问题。
 *
 * 这里只依赖三样东西：应用层的用例、表现层的 Cookie 契约、以及组合根拿到的实现。
 * **刻意不引用 `src/infrastructure/**`**——《依赖边界规则》禁止 `app/**` 引用基础设施；
 * 具体实现只在组合根里被引用一次，这里经组合根取得端口。
 */
import type { NextRequest, NextResponse } from 'next/server';

import {
  EnsureLocalSessionUseCase,
  type EnsureLocalSessionResult,
} from '@/modules/identity/application/ensure-local-session.ts';
import {
  SESSION_COOKIE_NAME,
  sessionCookieAttributes,
} from '@/modules/identity/presentation/session-cookie.ts';
import { serverEnv } from '@/shared/validation/env.server.ts';

import {
  getLifeAreaSeeds,
  getRepositories,
  getSessionTokenService,
} from '../../composition-root.ts';

/**
 * 解析请求会话，必要时自动建立本地会话。
 *
 * 不返回 401 是刻意的（§4.6）：本地模式没有"登录"可做，核心功能必须在无 Cookie
 * 时也可用。云端模式的 401 语义随云端批次实现，本批只保留 `AUTHENTICATION_REQUIRED`
 * 这个错误码的位置。
 */
export async function resolveSession(request: NextRequest): Promise<EnsureLocalSessionResult> {
  const useCase = new EnsureLocalSessionUseCase({
    users: getRepositories().users,
    signer: getSessionTokenService(),
    lifeAreaSeeds: getLifeAreaSeeds(),
  });

  return useCase.execute({
    sessionToken: request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null,
  });
}

/** 若本次调用签发了新令牌，则把它写进响应的 `Set-Cookie`。 */
export function withSessionCookie<T>(
  response: NextResponse<T>,
  session: EnsureLocalSessionResult,
): NextResponse<T> {
  if (session.issuedToken !== null) {
    response.cookies.set(
      SESSION_COOKIE_NAME,
      session.issuedToken,
      sessionCookieAttributes(serverEnv.nodeEnv === 'production'),
    );
  }
  return response;
}
