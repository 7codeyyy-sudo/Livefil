/**
 * MSW 拦截能力测试（FND-003）。
 *
 * 这些用例验证的是「测试基础设施本身可用」：拦截生效、失败路径可模拟、
 * handler 覆盖不会泄漏、未覆盖请求不会穿透到真实网络。
 * 业务层面的接口测试将从 TASK/SYNC 阶段起建立在这些能力之上。
 */
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { server, enableMswServer } from '../setup/msw-server.ts';

enableMswServer();

/**
 * 测试用保留域名。
 * `example.test` 属于 RFC 6761 保留的测试域，永远不会有真实解析，
 * 因此即使拦截意外失效，请求也打不到任何真实服务。
 */
const RESERVED_ORIGIN = 'http://example.test';

const GREETING_URL = `${RESERVED_ORIGIN}/api/greeting`;
const BROKEN_URL = `${RESERVED_ORIGIN}/api/broken`;

describe('MSW Node 侧拦截', () => {
  it('被 handler 覆盖的请求返回 mock 响应', async () => {
    server.use(http.get(GREETING_URL, () => HttpResponse.json({ message: 'mocked' })));

    const response = await fetch(GREETING_URL);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: 'mocked' });
  });

  it('可以模拟错误响应，用于验证失败路径', async () => {
    server.use(http.get(BROKEN_URL, () => HttpResponse.json({ message: 'boom' }, { status: 500 })));

    const response = await fetch(BROKEN_URL);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ message: 'boom' });
  });

  it('未覆盖的请求直接失败，不会穿透到真实网络', async () => {
    // 这条用例保障的是 `onUnhandledRequest: 'error'` 的设定：
    // 若改成放行，测试会在「以为已被 mock」的假设下依赖真实网络，
    // 表现为难以复现的随机失败。
    await expect(fetch(`${RESERVED_ORIGIN}/api/unhandled`)).rejects.toThrow();
  });

  it('handler 覆盖可被显式重置', async () => {
    server.use(http.get(GREETING_URL, () => HttpResponse.json({ message: 'temporary' })));
    expect((await fetch(GREETING_URL)).status).toBe(200);

    server.resetHandlers();

    // 重置后回到「未覆盖」状态：证明覆盖是临时的，不会在用例之间泄漏。
    await expect(fetch(GREETING_URL)).rejects.toThrow();
  });
});
