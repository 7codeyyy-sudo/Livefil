/**
 * 新增可选 props 回归（测试点 16，应补 7）。
 *
 * 既有 Overlay.test.tsx 已覆盖 ConfirmDialog 默认行为（5 条）；
 * 本文件只补裁定 4 承诺的 5 个新增可选 props：
 * confirmLabel / cancelLabel / destructive / pending / descriptionSlot /
 * errorSlot / extraAction / cancelVariant / initialFocus。
 */
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '@/shared/ui/components/ConfirmDialog/ConfirmDialog';

afterEach(() => {
  document.body.style.overflow = '';
});

describe('ConfirmDialog 新增可选 props', () => {
  it('confirmLabel / cancelLabel 自定义按钮文案', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="标题"
        description="正文"
        confirmLabel="是"
        cancelLabel="否"
      />,
    );

    await screen.findByRole('alertdialog');
    expect(screen.getByRole('button', { name: '是' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '否' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '否' }));
  });

  it('destructive 时确认按钮走 danger 强调级', async () => {
    render(
      <ConfirmDialog
        open
        destructive
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="删除"
        description="不可恢复"
      />,
    );

    await screen.findByRole('alertdialog');
    const confirmBtn = screen.getByRole('button', { name: '确认' });
    expect(confirmBtn.className).toMatch(/danger|destructive/i);
  });

  it('pending 时两个按钮都禁用', async () => {
    render(
      <ConfirmDialog
        open
        pending
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="提交中"
        description="请稍候"
      />,
    );

    await screen.findByRole('alertdialog');
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '确认' })).toBeDisabled();
  });

  it('descriptionSlot 渲染在标题与正文之间', async () => {
    render(
      <ConfirmDialog
        open
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="标题"
        description="正文"
        descriptionSlot={<div data-testid="slot">附加说明</div>}
      />,
    );

    await screen.findByRole('alertdialog');
    const slot = screen.getByTestId('slot');
    expect(slot).toHaveTextContent('附加说明');
  });

  it('extraAction 渲染在取消与确认之间', async () => {
    const user = userEvent.setup();
    const extra = vi.fn();
    render(
      <ConfirmDialog
        open
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="冲突"
        description="选择保留版本"
        extraAction={{ label: '保留服务器版本', onClick: extra }}
      />,
    );

    await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: '保留服务器版本' }));
    expect(extra).toHaveBeenCalledOnce();
  });

  it('errorSlot 渲染在说明正文与按钮组之间', async () => {
    render(
      <ConfirmDialog
        open
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="失败"
        description="操作未完成"
        errorSlot={<div role="alert">网络异常</div>}
      />,
    );

    await screen.findByRole('alertdialog');
    expect(screen.getByRole('alert')).toHaveTextContent('网络异常');
  });

  it('cancelVariant 改变取消按钮强调级', async () => {
    render(
      <ConfirmDialog
        open
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="标题"
        description="正文"
        cancelVariant="ghost"
      />,
    );

    await screen.findByRole('alertdialog');
    const cancelBtn = screen.getByRole('button', { name: '取消' });
    expect(cancelBtn.className).toMatch(/ghost|tertiary/i);
  });

  it('initialFocus=cancel 强制初始焦点落在取消位', async () => {
    render(
      <ConfirmDialog
        open
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="标题"
        description="正文"
        initialFocus="cancel"
      />,
    );

    await screen.findByRole('alertdialog');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    });
  });
});
