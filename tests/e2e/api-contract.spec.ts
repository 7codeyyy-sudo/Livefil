/**
 * API 契约的端到端验证（FND-005）。
 *
 * 这一组用例的存在理由：FND-005 的原语（requestId 解析、统一错误响应）如果只在
 * 集成测试里被验证，那「闭环」发生在测试里而不是运行系统里。
 * 这里用**真实构建产物 + 真实 HTTP**验证两件事：
 *
 *   1. 《接口文档》§1.1 的 `X-Request-Id` 契约（缺失生成、响应头回写同值）。
 *   2. §1.4 的统一错误结构在 404 这种「没有业务逻辑的失败」上同样成立。
 *
 * 这两条都无法用单元测试替代：代理层是否真的挂上、catch-all 是否真的匹配，
 * 只有跑起来才知道。
 */
import { expect, test } from '@playwright/test';

const PROVIDED_REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('健康检查回写客户端提供的 X-Request-Id', async ({ request }) => {
  const response = await request.get('/api/v1/health', {
    headers: { 'x-request-id': PROVIDED_REQUEST_ID },
  });

  expect(response.status()).toBe(200);
  expect(response.headers()['x-request-id']).toBe(PROVIDED_REQUEST_ID);
  // 响应体保持锁定：包装器只补响应头，不加字段。
  await expect(response.json()).resolves.toEqual({ status: 'ok' });
});

test('缺失 X-Request-Id 时生成合法 UUID 并回写', async ({ request }) => {
  const response = await request.get('/api/v1/health');

  expect(response.status()).toBe(200);
  expect(response.headers()['x-request-id']).toMatch(UUID_V4);
});

test('非法 X-Request-Id 被丢弃并生成新值', async ({ request }) => {
  const response = await request.get('/api/v1/health', {
    headers: { 'x-request-id': 'req_123' },
  });

  expect(response.headers()['x-request-id']).not.toBe('req_123');
  expect(response.headers()['x-request-id']).toMatch(UUID_V4);
});

test('不存在的 API 路由返回统一 JSON 404，而不是 HTML 错误页', async ({ request }) => {
  const response = await request.get('/api/v1/__does_not_exist__');

  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('application/json');

  const requestId = response.headers()['x-request-id'];
  expect(requestId).toMatch(UUID_V4);

  const body = await response.json();
  expect(body.error.code).toBe('NOT_FOUND');
  expect(body.error.requestId).toBe(requestId);
});

test('/api/v1 前缀本身也返回结构化 404', async ({ request }) => {
  const response = await request.get('/api/v1');

  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('application/json');
  await expect(response.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
});

test('页面路由的 404 仍是 HTML（统一结构只作用于 API）', async ({ request }) => {
  const response = await request.get('/__does_not_exist__');

  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('text/html');
});
