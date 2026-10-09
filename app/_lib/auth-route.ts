/**
 * 认证端点的共享助手（AUTH-002，《接口文档》v0.8 认证端点总表；RD-012 §4/§5）。
 *
 * 两件事收口在这里，8 个 `/auth/cloud/*` 路由共用：
 *
 * 1. **形态判据**：本地部署下调用认证端点返回结构化 404（FND-005 语义——
 *    本形态未启用认证），认证部署才进业务逻辑。判据同 `APP_MODE` 单源。
 * 2. **限流原料**：客户端 IP 与 User-Agent。IP 取 `x-forwarded-for` 首跳
 *    （反代链上最接近真实客户端的一跳），回退 `x-real-ip`，再回退
 *    `'unknown'`——回退值仍参与限流键，避免无头请求绕开计数。
 *
 * 与 `session-api.ts` 同样的理由：把这两件事写 8 遍必然漂移，而认证端点的
 * 漂移表现是"某个端点少了限流"——那是安全缺陷，不是样式问题。
 */
import type { NextRequest, NextResponse } from 'next/server';

import { NotFoundError } from '@/shared/errors/app-error.ts';
import {
  SESSION_COOKIE_NAME,
  sessionCookieAttributes,
} from '@/modules/identity/presentation/session-cookie.ts';
import { serverEnv } from '@/shared/validation/env.server.ts';

/** 本地部署下调用认证端点 → 结构化 404（契约 v0.8 双态总则）。 */
export function assertCloudMode(): void {
  if (serverEnv.appMode !== 'cloud') {
    throw new NotFoundError('请求的接口不存在');
  }
}

/** 取限流用的客户端 IP（契约 §14.1；见文件头注释的回退链）。 */
export function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null && forwarded.trim() !== '') {
    // 反代链可能逗号分隔多跳：首跳最接近真实客户端。
    const first = (forwarded.split(',')[0] ?? '').trim();
    if (first !== '') {
      return first;
    }
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp !== null && realIp.trim() !== '') {
    return realIp.trim();
  }
  return 'unknown';
}

/** 请求的 User-Agent（设备标签原料；清洗在 `sanitizeDeviceLabel`）。 */
export function userAgentOf(request: NextRequest): string | null {
  return request.headers.get('user-agent');
}

/**
 * 认证端点的 `Set-Cookie`（#2/#3 成功签发时）。
 *
 * 与 `withSessionCookie` 的区别：本函数只被 `/auth/cloud/*` 调用
 * （`assertCloudMode` 已保证认证部署），因此**恒带 maxAge**——与
 * `sessions.expires_at`（30 天）对齐；本地部署的无 maxAge 语义不受影响
 * （那些调用点走 `session-api.ts`）。
 */
export function setAuthCookie<T>(response: NextResponse<T>, token: string): NextResponse<T> {
  response.cookies.set(
    SESSION_COOKIE_NAME,
    token,
    sessionCookieAttributes(serverEnv.nodeEnv === 'production', CLOUD_COOKIE_MAX_AGE),
  );
  return response;
}

/** 认证部署的 Cookie 有效期（秒）——与 `sessions` 的 30 天 TTL 对齐。
 *  数值单一定义源在 `identity/domain/session.ts` 的 `SESSION_TTL_DAYS`；
 *  此处按《依赖边界规则》不引领域层而复述同值（AUTH-004 测试点核对两处一致）。 */
const CLOUD_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
