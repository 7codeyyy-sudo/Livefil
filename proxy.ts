/**
 * 请求 ID 代理层（FND-005）。
 *
 * 履行的契约：《接口文档》§1.1 的 `X-Request-Id: <client-request-id>`。
 * 客户端提供合法值时原样沿用，缺失或非法时生成新的，并**在响应头回写同一个值**——
 * 没有回写，客户端就无法把一次失败与日志里的记录对应起来，这个头也就失去了意义。
 *
 * 为什么必须放在这一层：requestId 需要「一个请求一个值」，
 * 而路由处理器是每个端点各自实现的，逐个埋点必然会有遗漏。
 * 代理层是 Next 规定的唯一边界。
 *
 * 为什么叫 `proxy` 而不是 `middleware`：Next 16 起 `middleware` 文件约定已废弃并更名。
 * 两者**不能并存**——同时存在会让构建直接失败（E900），所以这里是改名，并非留副本。
 * 导出函数必须命名为 `proxy`（或用 `default` 导出），否则构建期即失败
 * （官方 `proxy` 文件约定的强制要求）。
 *
 * 为什么 `config` 里只有 `matcher`：`proxy` **恒定运行在 Node.js 运行时**，
 * 这由 Next 强制，因此下面引用的 `request-id.ts`（使用 `node:crypto`）不存在 Edge
 * 兼容问题，也就无需声明运行时；反过来说，在这类文件里声明 `runtime` 会让 Next
 * 在生产构建时直接抛错（E1031），dev 下仅告警——所以这一行删掉是对的。
 */
import { NextResponse, type NextRequest } from 'next/server';

import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

/**
 * 解析并贯穿请求 ID。
 *
 * @param request 进入的请求。
 * @returns 携带 `x-request-id` 响应头的透传响应。
 */
export function proxy(request: NextRequest): NextResponse {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));

  // 续传给下游：让路由处理器读到的是**已经解析过**的值，
  // 避免各处再解析一次而产生不一致的来源。
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set(REQUEST_ID_HEADER, requestId);

  const response = NextResponse.next({ request: { headers: forwardedHeaders } });
  response.headers.set(REQUEST_ID_HEADER, requestId);

  return response;
}

export const config = {
  /**
   * 只作用于 API 路由。
   *
   * 页面与静态资源同样可以记录 requestId，但那属于访问日志的范畴，
   * 而访问日志涉及请求内容脱敏的独立设计，不在本任务范围。
   * 缩小匹配范围同时也避免了给每个静态资源请求增加一层处理。
   */
  matcher: ['/api/:path*'],
};
