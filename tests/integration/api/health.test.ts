// @vitest-environment node
/**
 * 健康检查接口测试（FND-003）。
 *
 * 覆盖方式：直接调用路由处理函数，而不是启动 HTTP 服务器。
 * 目的是验证**接口自身的契约**（状态码、响应体形状），不是验证网络栈——
 * 后者属于 E2E 的职责（见 `tests/e2e/home.spec.ts` 中对同一端点的真实请求）。
 *
 * 环境用 node 而非 jsdom：路由处理器运行在服务端，用 jsdom 会引入浏览器全局，
 * 从而掩盖「这段代码本不该依赖浏览器 API」这一重要事实。
 */
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { GET } from '../../../app/api/v1/health/route';

/**
 * 构造进入路由处理器的请求。
 *
 * FND-005 起 health 经统一错误包装器导出，签名与其他 API 路由一致
 * （接收 request 与 context），因此测试也必须以同样的方式调用它——
 * 否则测的就不是生产上真正执行的那个函数。
 *
 * @param headers 附加请求头。
 * @returns NextRequest 实例。
 */
function createRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/v1/health', { headers });
}

describe('GET /api/v1/health', () => {
  it('返回 200 与 status: ok', async () => {
    const response = await GET(createRequest(), undefined);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('响应体只有 status 一个字段', async () => {
    const body = await (await GET(createRequest(), undefined)).json();

    // 健康探针的输出会被监控系统消费，字段一旦增长就会变成事实契约。
    // 用这个断言把「保持最小」固定下来，避免后续顺手往里加信息。
    expect(Object.keys(body)).toEqual(['status']);
  });

  it('以 JSON 内容类型返回', async () => {
    const response = await GET(createRequest(), undefined);

    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('回写 x-request-id 响应头', async () => {
    // 《接口文档》§14 锁定的是**响应体**不变；包装器只额外补这一个头。
    const provided = '550e8400-e29b-41d4-a716-446655440000';
    const response = await GET(createRequest({ 'x-request-id': provided }), undefined);

    expect(response.headers.get('x-request-id')).toBe(provided);
  });
});
