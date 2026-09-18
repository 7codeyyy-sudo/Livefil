/**
 * Toast 的行为测试（UI-002 批次 3b）。
 *
 * 计时相关的用例一律用**假定时器**：5s / 8s / 常驻三档口径、悬停暂停、
 * 队列上限都是"时间与队列"的逻辑，真等 5 秒会让整个套件慢到没人愿意跑。
 *
 * 这里测不到的几何量（底部居中、堆叠方向、`--z-toast` 高于浮层）
 * 归 `tests/e2e/styleguide.spec.ts`——jsdom 没有布局引擎，也不做层叠排序。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider, useToast } from '@/shared/ui/components';

/** 退场兜底移除的时长，与组件内常量保持一致（见 Toast.tsx）。 */
const EXIT_FALLBACK_MS = 1000;

type HarnessProps = {
  readonly onUndo?: () => void;
};

/** 把 `useToast()` 的四个入口都挂成按钮，供用例点击。 */
function Harness({ onUndo = () => undefined }: HarnessProps) {
  const toast = useToast();
  const [lastId, setLastId] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          toast.show('已保存');
        }}
      >
        普通
      </button>

      <button
        type="button"
        onClick={() => {
          toast.success('已归档');
        }}
      >
        成功
      </button>

      <button
        type="button"
        onClick={() => {
          toast.error('同步失败，请重试');
        }}
      >
        错误
      </button>

      <button
        type="button"
        onClick={() => {
          toast.show('任务已归档', { action: { label: '撤销', onClick: onUndo } });
        }}
      >
        带操作
      </button>

      <button
        type="button"
        onClick={() => {
          for (let index = 1; index <= 4; index += 1) {
            toast.show(`第 ${String(index)} 条`);
          }
        }}
      >
        连发四条
      </button>

      <button
        type="button"
        onClick={() => {
          setLastId(toast.show('待关闭'));
        }}
      >
        记 id 发一条
      </button>

      <button
        type="button"
        onClick={() => {
          if (lastId !== null) {
            toast.dismiss(lastId);
          }
        }}
      >
        按 id 关闭
      </button>
    </div>
  );
}

function renderHarness(props: HarnessProps = {}): void {
  render(
    <ToastProvider>
      <Harness {...props} />
    </ToastProvider>,
  );
}

function click(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

/** 推进假定时器，并让 React 把这些定时器触发的状态更新刷新出来。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function stateOf(element: HTMLElement): string | null {
  return element.getAttribute('data-state');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useToast · 契约', () => {
  it('未挂 Provider 时直接抛错，而不是静默丢弃提示', () => {
    function Bare() {
      useToast();
      return null;
    }

    // 静默降级会让一次「保存成功」的提示凭空消失——而它往往是用户确认
    // 操作已生效的唯一反馈，比开发期崩掉更难查。
    expect(() => {
      render(<Bare />);
    }).toThrow(/ToastProvider/);
  });
});

describe('Toast · 语义与结构', () => {
  it('普通提示是 status，且挂在 body 下', () => {
    renderHarness();
    click('普通');

    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('已保存');
    expect(toast.getAttribute('data-variant')).toBe('info');

    const region = document.querySelector('[data-toast-region]');
    expect(region).not.toBeNull();
    expect(region?.contains(toast)).toBe(true);
    // 挂到 body 下才能浮在所有页面内容与浮层之上
    expect(document.body.contains(region)).toBe(true);
  });

  it('成功态是 status，变体为 success', () => {
    renderHarness();
    click('成功');

    expect(screen.getByRole('status').getAttribute('data-variant')).toBe('success');
  });

  it('错误态是 alert（读屏播报更主动）', () => {
    renderHarness();
    click('错误');

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('同步失败，请重试');
    expect(alert.getAttribute('data-variant')).toBe('danger');
  });

  it('外层容器不套 aria-live，避免同一条被播报两次', () => {
    renderHarness();
    click('普通');

    const region = document.querySelector('[data-toast-region]');
    expect(region?.hasAttribute('aria-live')).toBe(false);
    expect(region?.getAttribute('role')).toBeNull();
  });
});

describe('Toast · 自动关闭时长', () => {
  it('普通提示 5 秒后进入退场', async () => {
    vi.useFakeTimers();
    renderHarness();
    click('普通');

    expect(stateOf(screen.getByRole('status'))).toBe('open');

    await advance(4999);
    expect(stateOf(screen.getByRole('status'))).toBe('open');

    await advance(1);
    expect(stateOf(screen.getByRole('status'))).toBe('closed');
  });

  it('带操作按钮的 8 秒内不会关闭', async () => {
    vi.useFakeTimers();
    renderHarness();
    click('带操作');

    await advance(5000);
    expect(stateOf(screen.getByRole('status'))).toBe('open');

    await advance(3000);
    expect(stateOf(screen.getByRole('status'))).toBe('closed');
  });

  it('错误态常驻：一分钟后仍在（NFR-REL-002）', async () => {
    vi.useFakeTimers();
    renderHarness();
    click('错误');

    await advance(60000);
    expect(stateOf(screen.getByRole('alert'))).toBe('open');
  });
});

describe('Toast · 暂停计时', () => {
  it('指针悬停时暂停，移出后重新计时', async () => {
    vi.useFakeTimers();
    renderHarness();
    click('普通');

    const toast = screen.getByRole('status');
    fireEvent.mouseEnter(toast);

    await advance(60000);
    expect(stateOf(screen.getByRole('status'))).toBe('open');

    fireEvent.mouseLeave(toast);

    // 「重新计时」而不是接着剩余时间走
    await advance(4999);
    expect(stateOf(screen.getByRole('status'))).toBe('open');

    await advance(1);
    expect(stateOf(screen.getByRole('status'))).toBe('closed');
  });

  it('键盘焦点进入时暂停', async () => {
    vi.useFakeTimers();
    renderHarness();
    click('普通');

    fireEvent.focus(screen.getByRole('status'));

    await advance(60000);
    expect(stateOf(screen.getByRole('status'))).toBe('open');
  });
});

describe('Toast · 队列与 3 条上限', () => {
  it('连发 4 条只留 3 条，淘汰最老的那条', () => {
    renderHarness();
    click('连发四条');

    expect(screen.getAllByRole('status')).toHaveLength(3);
    expect(screen.queryByText('第 1 条')).toBeNull();
    expect(screen.getByText('第 4 条')).toBeInTheDocument();
  });

  it('新条排在队列末尾（渲染在堆叠的最下方）', () => {
    renderHarness();
    click('普通');
    click('成功');

    const items = screen.getAllByRole('status');
    expect(items[0]).toHaveTextContent('已保存');
    expect(items[1]).toHaveTextContent('已归档');
  });

  it('常驻的错误条不会被新来的普通条挤掉', () => {
    renderHarness();
    click('错误');
    click('普通');
    click('普通');
    click('普通');

    expect(screen.getByRole('alert')).toHaveTextContent('同步失败，请重试');
    // 3 个槽里除去常驻的那条，只剩 2 个给普通提示
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(document.querySelectorAll('[data-toast-id]')).toHaveLength(3);
  });
});

describe('Toast · 操作槽与移除', () => {
  it('点操作槽同时执行回调并关掉这条', () => {
    const onUndo = vi.fn();
    renderHarness({ onUndo });
    click('带操作');

    fireEvent.click(screen.getByRole('button', { name: '撤销' }));

    expect(onUndo).toHaveBeenCalledOnce();
    // 不关掉的话用户会以为还没处理
    expect(stateOf(screen.getByRole('status'))).toBe('closed');
  });

  it('dismiss(id) 能按 id 精确关掉一条', () => {
    renderHarness();
    click('记 id 发一条');
    expect(screen.getByText('待关闭')).toBeInTheDocument();

    click('按 id 关闭');

    expect(stateOf(screen.getByRole('status'))).toBe('closed');
  });

  it('退场过渡结束即从队列移除', async () => {
    renderHarness();
    click('普通');

    const toast = screen.getByRole('status');
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(stateOf(screen.getByRole('status'))).toBe('closed');

    fireEvent.transitionEnd(toast);

    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  it('过渡没触发时由兜底定时器移除（不释放槽位会让上限提前生效）', async () => {
    vi.useFakeTimers();
    renderHarness();
    click('普通');
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));

    await advance(EXIT_FALLBACK_MS - 1);
    expect(screen.queryByRole('status')).not.toBeNull();

    await advance(1);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
