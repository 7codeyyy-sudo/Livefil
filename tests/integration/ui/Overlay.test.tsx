/**
 * 浮层组件的行为测试（UI-002 批次 3a）。
 *
 * 这一层能测到的是**结构与状态**：Portal 挂载位置、滚动锁的存取、ARIA 关联、
 * ESC 回调、延迟卸载的时序。真正的焦点循环与几何量归
 * `tests/e2e/styleguide.spec.ts`（真实浏览器）——jsdom 没有布局引擎，
 * `Tab` 也不会自动移动焦点。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog, Modal } from '@/shared/ui/components';

/** 滚动锁会改 `document.body`，测试之间必须复位，否则会互相污染。 */
afterEach(() => {
  document.body.style.overflow = '';
});

describe('Modal · 结构与无障碍', () => {
  it('关闭时不渲染任何内容', () => {
    render(
      <Modal open={false} onClose={vi.fn()} title="编辑任务">
        内容
      </Modal>,
    );

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('打开后挂到 body 下，而不是留在组件树里', async () => {
    render(
      <div data-testid="host">
        <Modal open onClose={vi.fn()} title="编辑任务">
          内容
        </Modal>
      </div>,
    );

    const dialog = await screen.findByRole('dialog');

    // Portal 的收益就在这里：浮层不受宿主元素的 overflow / transform 影响。
    expect(screen.getByTestId('host').contains(dialog)).toBe(false);
  });

  it('暴露 dialog 语义与标题关联', async () => {
    render(
      <Modal open onClose={vi.fn()} title="编辑任务">
        内容
      </Modal>,
    );

    const dialog = await screen.findByRole('dialog');

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('编辑任务');
  });
});

describe('Modal · 滚动锁', () => {
  it('打开时锁住背景滚动，关闭后解锁', async () => {
    const { rerender } = render(
      <Modal open onClose={vi.fn()} title="编辑任务">
        内容
      </Modal>,
    );
    await screen.findByRole('dialog');

    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <Modal open={false} onClose={vi.fn()} title="编辑任务">
        内容
      </Modal>,
    );

    await waitFor(() => {
      expect(document.body.style.overflow).toBe('');
    });
  });

  it('解锁时恢复的是打开前的原值，不是无条件清空', async () => {
    // 调用方可能本来就有自己的设置；无条件置空会悄悄改掉别人的样式。
    document.body.style.overflow = 'auto';

    const { rerender } = render(
      <Modal open onClose={vi.fn()} title="编辑任务">
        内容
      </Modal>,
    );
    await screen.findByRole('dialog');
    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <Modal open={false} onClose={vi.fn()} title="编辑任务">
        内容
      </Modal>,
    );

    await waitFor(() => {
      expect(document.body.style.overflow).toBe('auto');
    });
  });
});

describe('Modal · 键盘与焦点', () => {
  it('ESC 触发 onClose', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();

    render(
      <Modal open onClose={handleClose} title="编辑任务">
        内容
      </Modal>,
    );
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    expect(handleClose).toHaveBeenCalledOnce();
  });

  it('打开时焦点进入面板', async () => {
    render(
      <Modal open onClose={vi.fn()} title="编辑任务">
        内容
      </Modal>,
    );

    const dialog = await screen.findByRole('dialog');

    // 不把焦点搬进面板的话，键盘用户还停在背景页面上，Tab 会跑到浮层外。
    await waitFor(() => {
      expect(dialog).toHaveFocus();
    });
  });

  it('焦点不在本浮层内时不响应 ESC（嵌套时只关最内层）', async () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();

    render(
      <>
        <Modal open onClose={outerClose} title="外层">
          外层内容
        </Modal>
        <Modal open onClose={innerClose} title="内层">
          内层内容
        </Modal>
      </>,
    );

    // 后挂载的内层最后聚焦自己 ⇒ 焦点归属内层
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '内层' })).toHaveFocus();
    });

    await userEvent.setup().keyboard('{Escape}');

    expect(innerClose).toHaveBeenCalledOnce();
    // 一次按键把两层一起关掉，正是这条判据要防的事
    expect(outerClose).not.toHaveBeenCalled();
  });

  it('从关闭切换到打开时，焦点同样进入面板', async () => {
    // 这条路径必须单独测：直接以 `open` 初值渲染时，`useDelayedUnmount` 的
    // `mounted` 初值就是 true，面板**首帧即挂载**，焦点陷阱拿得到容器——
    // 于是绕过了"打开时面板要晚一帧挂载"这件事。
    // 浏览器端用例走的是"点击打开"，之前正是栽在这里：陷阱拿着空容器直接返回，
    // 且依赖不再变化 ⇒ 永不重试 ⇒ 弹窗开了但焦点留在背景页面上。
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
            打开
          </button>
          <Modal
            open={open}
            onClose={() => {
              setOpen(false);
            }}
            title="编辑任务"
          >
            内容
          </Modal>
        </>
      );
    }

    const user = userEvent.setup();
    render(<Host />);

    await user.click(screen.getByRole('button', { name: '打开' }));

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
            打开
          </button>
          <Modal
            open={open}
            onClose={() => {
              setOpen(false);
            }}
            title="编辑任务"
          >
            内容
          </Modal>
        </>
      );
    }

    render(<Host />);
    const opener = screen.getByRole('button', { name: '打开' });

    await user.click(opener);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    // 不归还的话焦点掉回 body，键盘用户要从头 Tab 一遍
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });
});

describe('Modal · 延迟卸载', () => {
  it('关闭后仍留在 DOM，过渡结束才移除', async () => {
    const { rerender } = render(
      <Modal open onClose={vi.fn()} title="编辑任务">
        内容
      </Modal>,
    );
    const dialog = await screen.findByRole('dialog');

    rerender(
      <Modal open={false} onClose={vi.fn()} title="编辑任务">
        内容
      </Modal>,
    );

    // 立刻移除的话退场动画根本没有机会播放
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'closed');

    fireEvent.transitionEnd(dialog);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('子元素的过渡不会提前引发卸载', async () => {
    const { rerender } = render(
      <Modal open onClose={vi.fn()} title="编辑任务">
        <p>段落</p>
      </Modal>,
    );
    const dialog = await screen.findByRole('dialog');

    rerender(
      <Modal open={false} onClose={vi.fn()} title="编辑任务">
        <p>段落</p>
      </Modal>,
    );

    // 子元素的过渡会冒泡到面板：不按 target 过滤就会提前把浮层卸掉
    const paragraph = dialog.querySelector('p');
    expect(paragraph).not.toBeNull();
    if (paragraph !== null) {
      fireEvent.transitionEnd(paragraph);
    }

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  it('语义是 alertdialog，描述经 aria-describedby 关联', async () => {
    render(
      <ConfirmDialog
        open
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="删除这个任务？"
        description="删除后无法恢复。"
      />,
    );

    const dialog = await screen.findByRole('alertdialog');

    expect(dialog).toHaveAccessibleName('删除这个任务？');
    // 读屏用户打开时就能听到后果，而不是只知道"有个对话框"
    expect(dialog).toHaveAccessibleDescription('删除后无法恢复。');
  });

  it('危险操作的初始焦点落在「取消」', async () => {
    render(
      <ConfirmDialog
        open
        destructive
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="删除这个任务？"
        description="删除后无法恢复。"
      />,
    );

    await screen.findByRole('alertdialog');

    // 用户随手按回车时，焦点若在「删除」上就等于一键删除
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    });
  });

  it('非危险操作的初始焦点落在面板本身', async () => {
    render(
      <ConfirmDialog
        open
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="导入 12 条记录？"
        description="同名记录会合并。"
      />,
    );

    const dialog = await screen.findByRole('alertdialog');

    // 落在面板上意味着按回车不会触发任何按钮——非危险场景下这是安全默认
    await waitFor(() => {
      expect(dialog).toHaveFocus();
    });
  });

  it('取消与确认各自触发对应回调', async () => {
    const user = userEvent.setup();
    const handleCancel = vi.fn();
    const handleConfirm = vi.fn();

    render(
      <ConfirmDialog
        open
        onCancel={handleCancel}
        onConfirm={handleConfirm}
        title="删除这个任务？"
        description="删除后无法恢复。"
      />,
    );
    await screen.findByRole('alertdialog');

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(handleCancel).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: '确认' }));
    expect(handleConfirm).toHaveBeenCalledOnce();
  });

  it('pending 时两个按钮都禁用，避免重复提交', async () => {
    render(
      <ConfirmDialog
        open
        pending
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="删除这个任务？"
        description="删除后无法恢复。"
      />,
    );
    await screen.findByRole('alertdialog');

    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '确认' })).toBeDisabled();
  });
});
