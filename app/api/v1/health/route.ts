/**
 * 健康检查接口（FND-003）。
 *
 * 存在理由：FND-003 的验收标准要求「至少有一个单元测试、一个 API 测试和一个页面
 * E2E 测试通过」，而此前项目没有任何 API 路由。这里提供**最小可测的**端点，
 * 让测试框架有真实对象可测，而不是为了凑数去 mock 一个不存在的接口。
 *
 * 刻意不在这里实现任何业务逻辑或健康判定（不查数据库、不探外部依赖）：
 * 真正的存活/就绪探针属于 OPS 阶段，且取决于尚未接入的数据库与仓储。
 * 现在多做一步，就会让后续 OPS 的实现被这个占位版本绑架。
 *
 * 路径遵循《接口文档》的 `/api/v1` 版本前缀约定。
 */
import { NextResponse } from 'next/server';

import { createApiRouteHandler } from '../../../_lib/api-route.ts';

/** 健康检查响应体。 */
export interface HealthResponse {
  readonly status: 'ok';
}

/**
 * 返回服务存活状态。
 *
 * 经统一错误包装器导出（FND-005）。响应体保持锁定不变——《接口文档》§14 已登记
 * 该端点固定返回 `{ status: 'ok' }`；包装器只额外补上 `x-request-id` 响应头。
 */
export const GET = createApiRouteHandler(
  (): NextResponse<HealthResponse> => NextResponse.json<HealthResponse>({ status: 'ok' }),
  { operation: 'health_check' },
);
