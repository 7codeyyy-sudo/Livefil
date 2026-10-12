/**
 * 请求代理层——两项职责（FND-005 请求 ID + AUTH-002 认证部署的页面门禁）。
 *
 * ## 职责一：请求 ID（FND-005，既有契约，逐字未动）
 *
 * 履行的契约：《接口文档》§1.1 的 `X-Request-Id: <client-request-id>`。
 * 客户端提供合法值时原样沿用，缺失或非法时生成新的，并**在响应头回写同一个值**——
 * 没有回写，客户端就无法把一次失败与日志里的记录对应起来，这个头也就失去了意义。
 *
 * 为什么必须放在这一层：requestId 需要「一个请求一个值」，
 * 而路由处理器是每个端点各自实现的，逐个埋点必然会有遗漏。
 * 代理层是 Next 规定的唯一边界。
 *
 * ## 职责二：页面登录门禁（`APP_MODE=cloud`，AUTH-002）
 *
 * 认证部署下，页面请求在**渲染之前**过一次会话校验：无/坏/过期/已吊销会话
 * 一律 307 到 `/login?next=<当前路径+查询>`，登录后原路返回。此前的表现是
 * 「页面裸渲染出空壳外壳，首个数据请求 401 后才被 `SessionGuard` 弹走」——
 * 功能上数据零泄露（API 各自 401），但用户会看到一屏空壳闪烁。
 *
 * 会话判据与 API 层**同源**：直接调用 `resolveSession`（取当前用户的唯一入口，
 * RD-012 §5.2），不存在第二套校验逻辑；半衰点滑动续期同样在页面访问时发生，
 * 重发的 Cookie 经 `withSessionCookie`（与 API 路由同一出口）落回响应。
 * 无 Cookie 的请求在校验链第 1 步即被拒绝且**不打库**，门禁的常态路径零数据库开销。
 *
 * 为什么是代理层而不是 layout：① 代理在渲染前执行，预渲染的静态页面同样被守卫，
 * 且未登录时连一页 HTML 都不产出；② 代理拿得到完整 URL，`next=` 回跳参数才有来源
 * （服务端 layout 拿不到 pathname）；③ Next 官方对 proxy 的定位原文就包括
 * 「authentication、redirect」。
 *
 * 三条边界（改动前先读）：
 * 1. **只拦页面，不拦 API**：API 的未登录表现是 §1.4 的 401 JSON 信封
 *    （`SessionGuard` 据此弹登录页、同步队列据此暂停）；把 API 也重定向到 HTML
 *    登录页会让客户端的错误解析直接碎掉。
 * 2. **只在 cloud 拦**：local 模式没有「登录」可做（自动本地会话，RD-012 §5.4
 *    「本地不受影响」红线），门禁在该模式下逐字节放行。
 * 3. **matcher 白名单反转（fail-closed）**：除认证页、夹具页与静态资源外，一切
 *    路径默认过门禁——将来新增业务页面无需记得回来加守卫。
 *
 * 与 `SessionGuard` 的分工：代理管「进入」（未登录到不了页面）；`(app)` 根的
 * `SessionGuard` 管「停留期间」（页面开着时会话被吊销/过期 → API 401 → 弹登录页）。
 *
 * ## 为什么叫 `proxy` 而不是 `middleware`：Next 16 起 `middleware` 文件约定已废弃
 * 并更名。两者**不能并存**——同时存在会让构建直接失败（E900），所以这里是改名，
 * 并非留副本。导出函数必须命名为 `proxy`（或用 `default` 导出），否则构建期即失败
 * （官方 `proxy` 文件约定的强制要求）。
 *
 * 为什么 `config` 里只有 `matcher`：`proxy` **恒定运行在 Node.js 运行时**，
 * 这由 Next 强制，因此下面引用的 `request-id.ts`（`node:crypto`）与会话校验链
 * （Postgres）都不存在 Edge 兼容问题，也就无需声明运行时；反过来说，在这类文件里
 * 声明 `runtime` 会让 Next 在生产构建时直接抛错（E1031），dev 下仅告警——
 * 所以这一行删掉是对的。
 */
import { NextResponse, type NextRequest } from 'next/server';

import { resolveSession, withSessionCookie } from './app/_lib/session-api.ts';
import { AuthenticationError } from '@/shared/errors/app-error.ts';
import { serverEnv } from '@/shared/validation/env.server.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

/**
 * 页面门禁：cloud 模式下把未登录请求送到登录页（携带 `next=` 回跳参数），
 * local 模式逐字节放行；校验链抛出的非认证错误（数据库不可达等）原样上抛——
 * 不把基础设施故障伪装成「请登录」，否则 DB 故障会表现为全员被踢去登录页。
 *
 * @param request 进入的请求（已被 matcher 限定为页面路径）。
 * @param forwardedHeaders 已注入解析后请求 ID 的请求头。
 * @param requestId 已解析的请求 ID（随响应头回写，与 API 路径行为一致）。
 * @returns 放行的透传响应，或指向登录页的 307。
 */
async function gatePage(
  request: NextRequest,
  forwardedHeaders: Headers,
  requestId: string,
): Promise<NextResponse> {
  if (serverEnv.appMode === 'cloud') {
    try {
      const session = await resolveSession(request);
      // 半衰点续期在页面访问时同样发生（用「使用」维持时效），新 Cookie 与
      // API 路由走同一出口，属性单点不漂移。
      const response = withSessionCookie(
        NextResponse.next({ request: { headers: forwardedHeaders } }),
        session,
      );
      response.headers.set(REQUEST_ID_HEADER, requestId);
      return response;
    } catch (error) {
      if (!(error instanceof AuthenticationError)) {
        throw error;
      }
      // `next` 只放站内「当前路径 + 查询串」；登录页消费前还会用 safeNext 再验
      // 一次同源（B4），两道校验互为兜底。用 nextUrl.clone() 而不是 request.url
      // 拼接：反向代理后面 request.url 的 scheme 是内部值，nextUrl 才反映外部地址。
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      loginUrl.search = '';
      loginUrl.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
      const redirect = NextResponse.redirect(loginUrl);
      redirect.headers.set(REQUEST_ID_HEADER, requestId);
      return redirect;
    }
  }

  const response = NextResponse.next({ request: { headers: forwardedHeaders } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

/**
 * 请求进入点。
 *
 * @param request 进入的请求。
 * @returns API 透传响应，或页面门禁的放行/重定向响应。
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));

  // 续传给下游：让路由处理器读到的是**已经解析过**的值，
  // 避免各处再解析一次而产生不一致的来源。
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set(REQUEST_ID_HEADER, requestId);

  // API：只做请求 ID（会话由各端点 resolveSession 自答 401 信封，见边界 1）。
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const response = NextResponse.next({ request: { headers: forwardedHeaders } });
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  }

  // 页面：cloud 模式下先过登录门禁。
  return gatePage(request, forwardedHeaders, requestId);
}

export const config = {
  /**
   * 两类匹配（fail-closed，见文件头边界 3）：
   * - `/api/:path*`：请求 ID 贯穿（既有契约，不受门禁影响）；
   * - 页面路径：除认证页（login/register/forgot-password——门禁自己要能进）、
   *   夹具页（styleguide——组件裸展示，不挂外壳也不需要会话）与静态资源
   *   （`_next` 前缀含 dev 的 HMR 端点；带扩展名的文件如 favicon/robots）外全覆盖。
   *   `/`（根路径存根）也在门禁内：未登录直达 `/` 会被送到登录页并记住回家的路。
   */
  matcher: [
    '/api/:path*',
    '/((?!api|login|register|forgot-password|styleguide|_next|favicon|.*\\..*).*)',
  ],
};
