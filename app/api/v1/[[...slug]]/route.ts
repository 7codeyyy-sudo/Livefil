/**
 * `/api/v1` 下未匹配路径的兜底（FND-005）。
 *
 * 存在理由：Next 对未匹配的路由返回**默认的 HTML 错误页**，而《接口文档》§1.4
 * 承诺所有失败都是 `{ error: { code, message, requestId } }`。少了这一层，
 * 「API 下一切失败都是统一结构」这句话就有例外，而客户端按 JSON 解析时
 * 会在最不该出问题的地方（404）拿到 HTML 而崩掉。
 *
 * 用可选 catch-all `[[...slug]]` 而不是 `[...slug]`：后者不匹配 `/api/v1` 本身，
 * 而裸访问该前缀同样应当得到结构化 404 而不是 HTML。
 *
 * 导出全部常见方法：未导出的方法会被 Next 以 405 处理，那同样是一次
 * 不走统一结构的失败响应。
 */
import { NotFoundError } from '@/shared/errors/app-error.ts';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';

/**
 * 统一的未匹配处理器。
 *
 * 抛出 `NotFoundError` 而不是直接构造响应：让错误经由与业务端点**完全相同**的
 * 转换路径，避免兜底逻辑与主路径各自维护一套响应结构而逐渐分叉。
 */
const respondNotFound = createApiRouteHandler(
  (): never => {
    throw new NotFoundError('请求的接口不存在');
  },
  { operation: 'api_route_not_found' },
);

export const GET = respondNotFound;
export const POST = respondNotFound;
export const PUT = respondNotFound;
export const PATCH = respondNotFound;
export const DELETE = respondNotFound;
export const HEAD = respondNotFound;
export const OPTIONS = respondNotFound;
