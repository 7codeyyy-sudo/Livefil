/**
 * Drawer 的行为测试（UI-002 批次 3b）。
 *
 * 这一层能测到的是**结构与状态**：Portal 挂载位置、`edge` 落点、三段结构、
 * ARIA 关联、ESC 回调、焦点进入与归还、延迟卸载时序。
 * 真正的几何量（贴右边、440px 宽、窄屏全屏、Footer 钉底）归
 * `tests/e2e/styleguide.spec.ts`——jsdom 没有布局引擎。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button, Drawer } from '@/shared/ui/components';

/** 滚动锁会改 `document.body`，测试之间必须复位，否则会互相污染。 */
afterEach(() => {
  document.body.style.overflow = '';
});

describe('Drawer · 结构与无障碍', () => {
  it('关闭时不渲染任何内容', () => {
    render(
      <Drawer open={false} onClose={vi.fn()} title="编辑任务">
        内容
      </Drawer>,
    );

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('打开后挂到 body 下，遮罩用 edge 落点', async () => {
    render(
      <div data-testid="host">
        <Drawer open onClose={vi.fn()} title="编辑任务">
          内容
        </Drawer>
      </div>,
    );

    const dialog = await screen.findByRole('dialog');
    // 留在原位置会被祖先的 overflow / transform 裁掉或改变定位基准
    expect(screen.getByTestId('host').contains(dialog)).toBe(false);

    const scrim = document.querySelector('[data-overlay-scrim]');
    expect(scrim).not.toBeNull();
    // edge 是 Drawer 与 Modal 的唯一落点差异，落在 data 属性上供 CSS 分派
    expect(scrim?.getAttribute('data-layout')).toBe('edge');
  });

  it('标题作为无障碍名称', async () => {
    render(
      <Drawer open onClose={vi.fn()} title="编辑任务">
        内容
      </Drawer>,
    );

    const dialog = await screen.findByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).not.toBeNull();
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('编辑任务');
  });

  it('没有 footer 时不渲染底部操作区', async () => {
    render(
      <Drawer open onClose={vi.fn()} title="编辑任务">
        内容
      </Drawer>,
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('footer')).toBeNull();
  });

  it('给了 footer 就渲染底部操作区', async () => {
    render(
      <Drawer open onClose={vi.fn()} title="编辑任务" footer={<Button>保存</Button>}>
        内容
      </Drawer>,
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('footer')).not.toBeNull();
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
  });

  it('默认渲染关闭按钮，closable=false 时不渲染', async () => {
    const { rerender } = render(
      <Drawer open onClose={vi.fn()} title="编辑任务">
        内容
      </Drawer>,
    );
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();

    rerender(
      <Drawer open onClose={vi.fn()} title="编辑任务" closable={false}>
        内容
      </Drawer>,
    );
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
  });
});

describe('Drawer · 交互', () => {
  it('ESC 触发 onClose', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();

    render(
      <Drawer open onClose={handleClose} title="编辑任务">
        内容
      </Drawer>,
    );
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    expect(handleClose).toHaveBeenCalledOnce();
  });

  it('点遮罩关闭，点面板不关闭', async () => {
    const handleClose = vi.fn();

    render(
      <Drawer open onClose={handleClose} title="编辑任务">
        内容
      </Drawer>,
    );

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(dialog);
    expect(handleClose).not.toHaveBeenCalled();

    const scrim = document.querySelector('[data-overlay-scrim]');
    expect(scrim).not.toBeNull();
    if (scrim !== null) {
      fireEvent.click(scrim);
    }
    expect(handleClose).toHaveBeenCalledOnce();
  });

  it('点关闭按钮触发 onClose', async () => {
    const handleClose = vi.fn();

    render(
      <Drawer open onClose={handleClose} title="编辑任务">
        内容
      </Drawer>,
    );
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    expect(handleClose).toHaveBeenCalledOnce();
  });

  it('打开时焦点进入面板', async () => {
    render(
      <Drawer open onClose={vi.fn()} title="编辑任务">
        内容
      </Drawer>,
    );

    const dialog = await screen.findByRole('dialog');

    // 不把焦点搬进面板，键盘用户还停在背景页面上
    await waitFor(() => {
      expect(dialog).toHaveFocus();
    });
  });

  it('从关闭切换到打开时，焦点同样进入面板', async () => {
    // 这一条覆盖的是批次 3a 只在浏览器端才暴露的那条路径：面板延迟一帧挂载，
    // 若行为 hook 只依赖 `open`，焦点陷阱会拿着空容器直接返回且**永不重试**。
    // 「初始 open」的用例绕过了它——所以这里必须走 false → true。
    const { rerender } = render(
      <Drawer open={false} onClose={vi.fn()} title="编辑任务">
        内容
      </Drawer>,
    );

    rerender(
      <Drawer open onClose={vi.fn()} title="编辑任务">
        内容
      </Drawer>,
    );

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(dialog).toHaveFocus();
    });
  });

  it('关闭后焦点归还触发元素', async () => {
    const user = userEvent.setup();

    function Host() {
      const [open, setOpen] = useState(false);

      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            打开抽屉
          </button>
          <Drawer
            open={open}
            onClose={() => {
              setOpen(false);
            }}
            title="编辑任务"
          >
            内容
          </Drawer>
        </>
      );
    }

    render(<Host />);
    const opener = screen.getByRole('button', { name: '打开抽屉' });

    await user.click(opener);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });
});

describe('Drawer · 延迟卸载', () => {
  it('关闭后仍留在 DOM，过渡结束才移除', async () => {
    const { rerender } = render(
      <Drawer open onClose={vi.fn()} title="编辑任务">
        内容
      </Drawer>,
    );
    const dialog = await screen.findByRole('dialog');

    rerender(
      <Drawer open={false} onClose={vi.fn()} title="编辑任务">
        内容
      </Drawer>,
    );

    // 立刻移除的话退场动画根本没有机会播放
    expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'closed');

    fireEvent.transitionEnd(dialog);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
