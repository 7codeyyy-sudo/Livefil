/**
 * 会话相关的端点助手（IAM-001 起；AUTH-002 承接**验收红线门禁**，RD-012 §5.2）。
 *
 * 每个需要"当前用户"的端点都要做同样两件事：解析/建立会话、在需要时下发 Cookie。
 * 写两遍以上就有两个可能漂移的版本，而 Cookie 属性一旦漂移，表现是"某些接口
 * 建立得起会话、另一些建立不起"这类极难归因的问题。
 *
 * ## 门禁为什么收口在这里（RD-012 §5.2）
 *
 * `resolveSession` 是**全部 API 端点取当前用户的唯一入口**（grep ≥100 处调用）。
 * `APP_MODE` 分支放在 `EnsureLocalSessionUseCase` 内部（构造注入 mode），
 * 本文件只负责把 `serverEnv.appMode` 与会话仓储传进去——于是「认证部署关闭
 * 自动本地会话、未登录 401」这条红线**零逐点改动**地覆盖全部端点，
 * 而 local 分支的装配与行为逐字节维持 IAM-001 现状。
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
 * 认证部署的 Cookie 有效期（秒）——与 `sessions` 的 30 天 TTL 对齐。
 *
 * 数值在路由层复述而不 import 领域常量：《依赖边界规则》禁止 `app/**` 引用
 * 模块领域层（该规则正是既有架构断言的判定对象）。30 天的**单一定义源**在
 * `identity/domain/session.ts` 的 `SESSION_TTL_DAYS`——两处同值由 AUTH-004
 * 测试点核对（RD-012 §7 #5 的 Cookie 属性断言覆盖）。
 */
const CLOUD_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * 解析请求会话。
 *
 * **本地部署**：不返回 401 是刻意的（§4.6）——本地模式没有"登录"可做，
 * 核心功能必须在无 Cookie 时也可用。
 *
 * **认证部署（`APP_MODE=cloud`，验收红线）**：关闭自动本地会话——无/坏/
 * 过期/已吊销会话一律抛 `AuthenticationError`（401 `AUTHENTICATION_REQUIRED`），
 * 由 `createApiRouteHandler` 统一转为 §1.4 信封，前端据此跳登录页。
 *
 * @throws {AuthenticationError} 仅认证部署可达（401）。
 */
export async function resolveSession(request: NextRequest): Promise<EnsureLocalSessionResult> {
  const repositories = getRepositories();
  const useCase = new EnsureLocalSessionUseCase({
    users: repositories.users,
    signer: getSessionTokenService(),
    lifeAreaSeeds: getLifeAreaSeeds(),
    // 门禁判据：APP_MODE（缺省 local）。local 分支对既有调用点零行为变化。
    mode: serverEnv.appMode,
    sessions: repositories.sessions,
  });

  return useCase.execute({
    sessionToken: request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null,
  });
}

/** 若本次调用签发/续期了令牌，则把它写进响应的 `Set-Cookie`。 */
export function withSessionCookie<T>(
  response: NextResponse<T>,
  session: EnsureLocalSessionResult,
): NextResponse<T> {
  if (session.issuedToken !== null) {
    // 认证部署带 maxAge（与 sessions.expires_at 对齐，续期时顺延重发）；
    // 本地部署不带——单参调用保持 IAM-001 的「随浏览器会话」语义。
    const maxAge = serverEnv.appMode === 'cloud' ? CLOUD_COOKIE_MAX_AGE : undefined;
    response.cookies.set(
      SESSION_COOKIE_NAME,
      session.issuedToken,
      sessionCookieAttributes(serverEnv.nodeEnv === 'production', maxAge),
    );
  }
  return response;
}
