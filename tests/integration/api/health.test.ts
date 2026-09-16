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
import { describe, expect, it } from 'vitest';

import { GET } from '../../../app/api/v1/health/route';

describe('GET /api/v1/health', () => {
  it('返回 200 与 status: ok', async () => {
    const response = GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('响应体只有 status 一个字段', async () => {
    const body = await GET().json();

    // 健康探针的输出会被监控系统消费，字段一旦增长就会变成事实契约。
    // 用这个断言把「保持最小」固定下来，避免后续顺手往里加信息。
    expect(Object.keys(body)).toEqual(['status']);
  });

  it('以 JSON 内容类型返回', () => {
    expect(GET().headers.get('content-type')).toContain('application/json');
  });
});
