// @vitest-environment node
/**
 * 页面门禁的失败模式契约（2026-10-13 实测缺陷的根治；关联 PM-20261012-008 交付）。
 *
 * ## 背景（真实事故）
 *
 * cloud 模式 + 合法 Cookie + 数据库宕机（Docker 未启动）时，门禁原先把非认证
 * 错误原样上抛 ⇒ **整站 500**，被锁死的恰恰是签名合法的正式用户；无/坏 Cookie
 * 的请求反而在第 1 步就被送去登录页（matcher 之外），毫发无损。修正后的错误
 * 分类（本文件逐类钉住）：
 *
 * - `AuthenticationError` ⇒ 307 登录页（不打库快拒 / 行状态不合法）；
 * - `InvariantError`（装配缺失）⇒ 原样上抛——配置错误要响亮，不静默放行；
 * - 其余（数据库不可达等基础设施故障）⇒ warn 日志 + 放行——数据的权威在
 *   API 层（库挂时各端点独立 500），页面门禁放行不吐任何数据。
 *
 * ## 为什么 mock 会话校验链
 *
 * 本文件只钉「错误**类** → 响应」的映射；会话判据本身（签名、行状态、续期）
 * 的行为由 `ensure-local-session` 各自的用例覆盖。mock 按代理文件里的导入
 * 路径声明，vitest 以解析后的绝对路径去重，两处写法指向同一个模块。
 */
import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthenticationError, InvariantError } from '@/shared/errors/app-error.ts';
import { REQUEST_ID_HEADER } from '@/shared/telemetry/request-id.ts';

vi.mock('../../../app/_lib/session-api.ts', () => ({
  resolveSession: vi.fn(),
  withSessionCookie: vi.fn(),
}));

import { resolveSession, withSessionCookie } from '../../../app/_lib/session-api.ts';
import type { proxy as ProxyFunction } from '../../../proxy.ts';

// `env.server` 在**模块加载期**解析一次（`parseServerEnv`），事后改环境变量
// 不生效——cloud 门禁必须在首次 import proxy 之前把 APP_MODE 钉住，因此
// proxy 用动态 import 取，而不是顶部静态 import。
process.env.APP_MODE = 'cloud';

let proxy: typeof ProxyFunction;

beforeAll(async () => {
  ({ proxy } = await import('../../../proxy.ts'));
});

/** 一个进入门禁的页面路径请求（matcher 已限定为页面路径）。 */
function pageRequest(path = '/today'): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

describe('页面门禁的错误分类', () => {
  it('认证失败 ⇒ 307 登录页（携 next 回跳参数）', async () => {
    vi.mocked(resolveSession).mockRejectedValueOnce(new AuthenticationError('需要登录后继续'));

    const response = await proxy(pageRequest('/today?tab=done'));

    expect(response.status).toBe(307);
    const location = response.headers.get('location') ?? '';
    expect(location).toMatch(/\/login\?next=/);
    expect(decodeURIComponent(location)).toContain('/today?tab=done');
  });

  it('装配缺失（InvariantError）⇒ 原样上抛，不静默放行', async () => {
    vi.mocked(resolveSession).mockRejectedValueOnce(
      new InvariantError({ message: '认证部署缺少会话仓储依赖' }),
    );

    await expect(proxy(pageRequest())).rejects.toThrow(InvariantError);
  });

  it('基础设施错误（数据库不可达）⇒ 放行透传：不 500、不 307、requestId 照写', async () => {
    const dbDown = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:55432'), {
      code: 'ECONNREFUSED',
    });
    vi.mocked(resolveSession).mockRejectedValueOnce(dbDown);

    const response = await proxy(pageRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });

  it('会话有效 ⇒ 放行，续期 Cookie 交由统一出口 withSessionCookie 处理', async () => {
    vi.mocked(resolveSession).mockResolvedValueOnce({
      userId: 'user-1',
      mode: 'cloud',
      issuedToken: null,
      created: false,
      sessionId: 'session-1',
    });
    vi.mocked(withSessionCookie).mockImplementationOnce((response) => response);

    const response = await proxy(pageRequest());

    expect(response.status).toBe(200);
    expect(vi.mocked(withSessionCookie)).toHaveBeenCalledOnce();
  });
});
