/**
 * 异步取数与离线提示的 jsdom 测试（UI-004，《UI 页面规范》v0.14 §4.7）。
 *
 * 覆盖四组：四态容器的分派、取数原语的行为（含 abort 与不自动重试）、
 * API 客户端的失败归一（走 MSW），以及离线横幅的出现与消失。
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';

import { AsyncState, OfflineBanner, useAsyncQuery } from '@/shared/ui/components';

import { fetchJson } from '../../../app/(app)/_lib/api-client.ts';
import { server, enableMswServer } from '../../setup/msw-server.ts';

enableMswServer();

/**
 * 测试用保留域名（RFC 6761）。
 *
 * 即使拦截意外失效，请求也打不到任何真实服务。**必须用绝对 URL**：
 * `fetchJson` 在应用里收的是同源相对路径，而 jsdom 会把相对路径解析到
 * `http://localhost:3000/`——MSW 的 handler 匹配绝对地址，用相对路径会
 * 落进 `onUnhandledRequest: 'error'`。
 */
const ORIGIN = 'http://example.test';

const EMPTY_CONTENT = { title: '这里还没有内容', description: '先记一件小事。' };

/** 把取数原语与四态容器接起来的最小宿主，用于观察用户实际看到的东西。 */
function Probe({
  queryKey,
  queryFn,
}: {
  readonly queryKey: readonly string[];
  readonly queryFn: (signal: AbortSignal) => Promise<string>;
}) {
  const { state, refetch } = useAsyncQuery<string>({ queryKey, queryFn });

  return (
    <AsyncState<string>
      state={state}
      isEmpty={(data) => data === 'EMPTY'}
      renderSuccess={(data) => <p>{data}</p>}
      empty={EMPTY_CONTENT}
      errorTitle="内容没能加载"
      onRetry={refetch}
    />
  );
}

describe('AsyncState 四态分派', () => {
  it('loading：渲染调用方给的骨架，并带 aria-busy', () => {
    render(
      <AsyncState<string>
        state={{ status: 'loading' }}
        isEmpty={() => false}
        renderSuccess={() => <p>真实内容</p>}
        empty={EMPTY_CONTENT}
        errorTitle="没能加载"
        loading={<span data-testid="skeleton">骨架</span>}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
  });

  it('success 且非空：渲染真实内容', () => {
    render(
      <AsyncState<string>
        state={{ status: 'success', data: '一份任务' }}
        isEmpty={() => false}
        renderSuccess={(data) => <p>{data}</p>}
        empty={EMPTY_CONTENT}
        errorTitle="没能加载"
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText('一份任务')).toBeInTheDocument();
  });

  it('success 但为空：走调用方给的 EmptyState', () => {
    render(
      <AsyncState<string>
        state={{ status: 'success', data: 'EMPTY' }}
        isEmpty={(data) => data === 'EMPTY'}
        renderSuccess={() => <p>真实内容</p>}
        empty={EMPTY_CONTENT}
        errorTitle="没能加载"
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText(EMPTY_CONTENT.title)).toBeInTheDocument();
    expect(screen.queryByText('真实内容')).toBeNull();
  });

  it('error：渲染错误态，描述缺省取真实的失败信息而不是写死的文案', () => {
    render(
      <AsyncState<string>
        state={{ status: 'error', error: new Error('服务暂时不可用') }}
        isEmpty={() => false}
        renderSuccess={() => <p>真实内容</p>}
        empty={EMPTY_CONTENT}
        errorTitle="内容没能加载"
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('内容没能加载')).toBeInTheDocument();
    expect(screen.getByText('服务暂时不可用')).toBeInTheDocument();
  });

  it('error：给了描述就用描述，覆盖技术信息', () => {
    render(
      <AsyncState<string>
        state={{ status: 'error', error: new Error('Failed to fetch') }}
        isEmpty={() => false}
        renderSuccess={() => <p>真实内容</p>}
        empty={EMPTY_CONTENT}
        errorTitle="内容没能加载"
        errorDescription="数据没能取回来。可以先重试。"
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText('数据没能取回来。可以先重试。')).toBeInTheDocument();
    expect(screen.queryByText('Failed to fetch')).toBeNull();
  });

  it('error：重试按钮是 primary 变体，点击调用 onRetry', async () => {
    const user = userEvent.setup();
    let retried = 0;

    render(
      <AsyncState<string>
        state={{ status: 'error', error: new Error('挂了') }}
        isEmpty={() => false}
        renderSuccess={() => <p>真实内容</p>}
        empty={EMPTY_CONTENT}
        errorTitle="内容没能加载"
        onRetry={() => {
          retried += 1;
        }}
      />,
    );

    const retry = screen.getByRole('button', { name: '重试' });
    expect(retry).toBeEnabled();

    await user.click(retry);
    expect(retried).toBe(1);

    // 「近黑 primary」这条样式断言不在这里做：jsdom 不解析样式表，读不到背景色；
    // 而 CSS Modules 的类名是构建期哈希，不该被测试依赖。它放在浏览器用例里
    // （能取到计算样式），见 tests/e2e/page-state.spec.ts。
  });
});

describe('取数原语', () => {
  it('初始为加载中，取数完成后渲染结果', async () => {
    const queryFn = (): Promise<string> => Promise.resolve('一份任务');

    render(<Probe queryKey={['a']} queryFn={queryFn} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');

    expect(await screen.findByText('一份任务')).toBeInTheDocument();
  });

  it('失败后停在错误态，不自动重试', async () => {
    let calls = 0;
    const queryFn = (): Promise<string> => {
      calls += 1;
      return Promise.reject(new Error('第一次就挂了'));
    };

    render(<Probe queryKey={['a']} queryFn={queryFn} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(calls).toBe(1);

    // 若原语会自己重试，这里会先回到 loading 骨架（role=status + aria-busy）。
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(calls).toBe(1);
  });

  it('只有用户点重试才会重新取数，且成功后渲染新结果', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const queryFn = (): Promise<string> => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('第一次就挂了'))
        : Promise.resolve('重试后的内容');
    };

    render(<Probe queryKey={['a']} queryFn={queryFn} />);
    await screen.findByRole('alert');
    expect(calls).toBe(1);

    await user.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByText('重试后的内容')).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('queryKey 变化会中止旧请求，且中止不落错误态', async () => {
    const signals: AbortSignal[] = [];
    const queryFn = (signal: AbortSignal): Promise<string> => {
      signals.push(signal);
      if (signals.length > 1) {
        return Promise.resolve('新数据');
      }
      // 第一个请求永不主动完成：模拟一个被取代的在途请求。
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    };

    const { rerender } = render(<Probe queryKey={['a']} queryFn={queryFn} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');

    rerender(<Probe queryKey={['b']} queryFn={queryFn} />);

    expect(await screen.findByText('新数据')).toBeInTheDocument();
    // 旧请求确实被中止了……
    expect(signals[0]?.aborted).toBe(true);
    // ……而它被中止时抛出的 AbortError 没有把界面推进错误态。
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => {
      expect(screen.getByText('新数据')).toBeInTheDocument();
    });
  });

  it('卸载时中止在途请求', () => {
    const signals: AbortSignal[] = [];
    const queryFn = (signal: AbortSignal): Promise<string> => {
      signals.push(signal);
      return new Promise<string>(() => undefined);
    };

    const { unmount } = render(<Probe queryKey={['a']} queryFn={queryFn} />);
    unmount();

    expect(signals[0]?.aborted).toBe(true);
  });

  it('抛出的不是 Error 时也归一成 Error（否则读不到 message）', async () => {
    const queryFn = (): Promise<string> => Promise.reject('字符串原因');

    render(<Probe queryKey={['a']} queryFn={queryFn} />);

    expect(await screen.findByText('字符串原因')).toBeInTheDocument();
  });
});

describe('API 客户端失败归一', () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it('成功时按 §1.2 的信封取回 data 与 meta', async () => {
    server.use(
      http.get(`${ORIGIN}/api/v1/tasks`, () =>
        HttpResponse.json({ data: [], meta: { hasMore: false } }),
      ),
    );

    const envelope = await fetchJson<readonly string[]>(
      `${ORIGIN}/api/v1/tasks`,
      new AbortController().signal,
    );

    expect(envelope.data).toEqual([]);
    expect(envelope.meta).toEqual({ hasMore: false });
  });

  it('非 2xx 时用服务端给的 message，而不是自己编一句', async () => {
    server.use(
      http.get(`${ORIGIN}/api/v1/goals`, () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL_ERROR', message: '目标服务暂时不可用' } },
          { status: 500 },
        ),
      ),
    );

    await expect(fetchJson(`${ORIGIN}/api/v1/goals`, new AbortController().signal)).rejects.toThrow(
      '目标服务暂时不可用',
    );
  });

  it('错误体不是约定的 JSON 时退回带状态码的文案', async () => {
    // 反代或托管平台的错误页就是这样：HTTP 200 的 content-type 也不是 JSON。
    server.use(
      http.get(
        `${ORIGIN}/api/v1/expenses`,
        () =>
          new HttpResponse('<html>500</html>', {
            status: 500,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );

    await expect(
      fetchJson(`${ORIGIN}/api/v1/expenses`, new AbortController().signal),
    ).rejects.toThrow('请求失败（500）');
  });

  it('响应不是信封结构时按契约违约报错，而不是悄悄当成空数据', async () => {
    server.use(http.get(`${ORIGIN}/api/v1/reviews/daily/2026-09-20`, () => HttpResponse.json([])));

    await expect(
      fetchJson(`${ORIGIN}/api/v1/reviews/daily/2026-09-20`, new AbortController().signal),
    ).rejects.toThrow('服务端响应格式不符合约定');
  });
});

describe('离线横幅', () => {
  /**
   * 设置连通性。
   *
   * 必须**同时**改 `navigator.onLine` 并派发事件：`useSyncExternalStore` 的
   * 快照读的是 `navigator.onLine`，而它变化时浏览器才会派发对应事件——
   * jsdom 不会自己产生这种联动，所以要手工把两件事都做掉。
   */
  function setOnline(value: boolean): void {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
    window.dispatchEvent(new Event(value ? 'online' : 'offline'));
  }

  afterEach(() => {
    setOnline(true);
  });

  it('在线时不渲染任何东西', () => {
    setOnline(true);
    const { container } = render(<OfflineBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it('离线时出现并播报，恢复在线后消失', () => {
    setOnline(true);
    render(<OfflineBanner />);
    expect(screen.queryByRole('status')).toBeNull();

    act(() => {
      setOnline(false);
    });
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('当前处于离线状态');
    // 文案只陈述事实：不说「会自动同步」——队列属 SYNC-002/003，尚不存在。
    expect(banner).not.toHaveTextContent('自动同步');

    act(() => {
      setOnline(true);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
