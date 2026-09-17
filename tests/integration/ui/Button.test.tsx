/**
 * Button / IconButton 的行为测试（UI-002 批次 1）。
 *
 * 只断言行为与无障碍语义。样式、几何量、断点行为归
 * `tests/e2e/styleguide.spec.ts`（真实浏览器）——两层不互替：
 * jsdom 没有布局引擎，测不到高度与响应式。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button, IconButton } from '@/shared/ui/components';

describe('Button', () => {
  it('默认渲染为 type="button"，避免在表单中意外提交', () => {
    render(<Button>保存</Button>);

    // HTML 的默认值是 submit。若不放这个默认值，表单里任何「取消」按钮
    // 都会顺手提交整个表单——这是真实项目里最常见的低级事故之一。
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('type', 'button');
  });

  it('点击时调用 onClick', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>保存</Button>);

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(handleClick).toHaveBeenCalledOnce();
  });

  it('disabled 时不可点击', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(
      <Button disabled onClick={handleClick}>
        保存
      </Button>,
    );

    const button = screen.getByRole('button', { name: '保存' });
    expect(button).toBeDisabled();

    await user.click(button);

    expect(handleClick).not.toHaveBeenCalled();
  });

  it('loading 时自动禁用并标记 aria-busy——这是「重复提交」的第一道闸门', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(
      <Button loading onClick={handleClick}>
        保存
      </Button>,
    );

    const button = screen.getByRole('button', { name: '保存' });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('data-loading', 'true');

    await user.click(button);

    expect(handleClick).not.toHaveBeenCalled();
  });

  it('Enter 与 Space 都能激活（§7 键盘可达）', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>保存</Button>);

    await user.tab();
    expect(screen.getByRole('button', { name: '保存' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(handleClick).toHaveBeenCalledTimes(1);

    await user.keyboard(' ');
    expect(handleClick).toHaveBeenCalledTimes(2);
  });

  it('非 loading 时不带 aria-busy', () => {
    render(<Button>保存</Button>);

    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-busy', 'false');
  });
});

describe('IconButton', () => {
  it('把 label 映射为 aria-label——图标按钮唯一的无障碍名称', () => {
    render(<IconButton label="关闭">×</IconButton>);

    // 能按名称查到，就证明读屏用户不会只听到一个光秃秃的「按钮」。
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
  });

  it('loading 时同样禁用并标记 aria-busy', () => {
    render(
      <IconButton label="关闭" loading>
        ×
      </IconButton>,
    );

    const button = screen.getByRole('button', { name: '关闭' });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});
