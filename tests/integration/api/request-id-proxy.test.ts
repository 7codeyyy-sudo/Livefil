// @vitest-environment node
/**
 * 请求 ID 代理层测试（FND-005）。
 *
 * 这里验证的是：《接口文档》§1.1 承诺的「缺失时生成、响应头返回同值」在
 * **真实的 proxy.ts** 上成立，而不是只验证 `resolveRequestId` 这个纯函数。
 *
 * 刻意不断言「请求头是否被续传给下游」：那依赖 Next 内部的
 * `x-middleware-request-*` 传输约定（该内部头名在改名为 proxy 后未变），
 * 属于实现细节。端到端是否真的贯穿，由 `tests/e2e/api-contract.spec.ts`
 * 在真实 HTTP 上验证。
 */
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { proxy } from '../../../proxy.ts';
import { REQUEST_ID_HEADER } from '@/shared/telemetry/request-id.ts';

const PROVIDED_REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * 构造一个进入代理层的请求。
 *
 * @param headers 附加请求头。
 * @returns NextRequest 实例。
 */
function createRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/v1/health', { headers });
}

describe('代理层回写 X-Request-Id', () => {
  it('客户端提供了合法值时原样沿用', () => {
    const response = proxy(createRequest({ [REQUEST_ID_HEADER]: PROVIDED_REQUEST_ID }));

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(PROVIDED_REQUEST_ID);
  });

  it('头缺失时生成合法 UUID 并回写', () => {
    const response = proxy(createRequest());

    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(UUID_V4);
  });

  it('头非法时丢弃原值并生成新的', () => {
    const response = proxy(createRequest({ [REQUEST_ID_HEADER]: 'req_123' }));
    const value = response.headers.get(REQUEST_ID_HEADER);

    expect(value).not.toBe('req_123');
    expect(value).toMatch(UUID_V4);
  });

  it('含换行的头值在构造阶段就被 Web 标准拒绝（注入面在入口即被阻断）', () => {
    // 这条用例记录的是「为什么这个攻击面不存在」：`Headers` 不接受含换行的值，
    // 因此恶意请求头根本到不了代理层。
    // `resolveRequestId` 里的格式校验是**第二道**防线，用于防御来自非 Headers 来源的
    // 字符串（内部调用、日志回放、将来可能出现的自定义传输）。
    expect(
      () =>
        new NextRequest('http://localhost/api/v1/health', {
          headers: { [REQUEST_ID_HEADER]: `${PROVIDED_REQUEST_ID}\nX-Injected: 1` },
        }),
    ).toThrow(TypeError);
  });

  it('大小写不同的头名同样被识别（HTTP 头名不区分大小写）', () => {
    const response = proxy(createRequest({ 'X-Request-Id': PROVIDED_REQUEST_ID }));

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(PROVIDED_REQUEST_ID);
  });

  it('每次请求各自解析，不会跨请求串号', () => {
    const first = proxy(createRequest()).headers.get(REQUEST_ID_HEADER);
    const second = proxy(createRequest()).headers.get(REQUEST_ID_HEADER);

    expect(first).not.toBe(second);
  });
});

describe('代理层的作用范围', () => {
  it('只匹配 /api 路径，避免给页面与静态资源增加处理', async () => {
    const proxyModule = await import('../../../proxy.ts');

    expect(proxyModule.config.matcher).toEqual(['/api/:path*']);
  });

  it('不得声明 runtime（proxy 恒定运行在 Node.js 运行时，声明会被 Next 拒绝）', async () => {
    const proxyModule = await import('../../../proxy.ts');
    const config = proxyModule.config as unknown as Record<string, unknown>;

    // 这条断言把「不许写」变成一条会变红的检查。
    // Next 在 proxy 文件里读到 `runtime` 会让**生产构建**直接失败（E1031），
    // 而 dev 下只是告警——也就是说它不会在日常开发里暴露，只会在构建时炸。
    // 与其留给下一个人从 Next 的报错里去发现，不如在这里立刻拦住。
    expect(config.runtime).toBeUndefined();
  });
});
