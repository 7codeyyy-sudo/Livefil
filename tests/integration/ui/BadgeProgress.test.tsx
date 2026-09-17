/**
 * Badge / Progress 的行为测试（UI-002 批次 2）。
 *
 * 只断言行为与无障碍语义。圆角是否真的全圆、填充宽度是否真的随 value 变化，
 * 归 `tests/e2e/styleguide.spec.ts`（真实浏览器）——jsdom 没有布局引擎。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Badge, Progress } from '@/shared/ui/components';

describe('Badge', () => {
  it('默认是中性变体，且用行内元素渲染', () => {
    render(<Badge>待整理</Badge>);

    const badge = screen.getByText('待整理');

    expect(badge).toHaveAttribute('data-variant', 'neutral');
    // 用 span 而非 div：徽章常出现在段落中间，块级元素会造成不该有的换行。
    expect(badge.tagName).toBe('SPAN');
  });

  it('四个变体的文字都真实存在（颜色不是唯一语义载体）', () => {
    // §2.1 明令「颜色不能成为唯一语义载体」。这条用最朴素的方式守住它：
    // 每个状态都有文字，因此把颜色全部去掉后语义仍然完整。
    for (const variant of ['neutral', 'success', 'warning', 'danger'] as const) {
      const { unmount } = render(<Badge variant={variant}>已完成</Badge>);

      expect(screen.getByText('已完成')).toBeInTheDocument();
      expect(screen.getByText('已完成')).toHaveAttribute('data-variant', variant);

      unmount();
    }
  });
});

describe('Progress', () => {
  it('暴露 aria 三属性，且与 value 一致', () => {
    render(<Progress value={58} label="目标进度" />);

    const bar = screen.getByRole('progressbar', { name: '目标进度' });

    expect(bar).toHaveAttribute('aria-valuenow', '58');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('小数先圆整再对外暴露，朗读值与屏幕文字保持同一个数', () => {
    render(<Progress value={58.4} label="目标进度" showValue />);

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '58');
    expect(screen.getByText('58%')).toBeInTheDocument();
  });

  it('边界值 0 与 100 都合法', () => {
    const { unmount } = render(<Progress value={0} label="今日完成度" showValue />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('0%')).toBeInTheDocument();
    unmount();

    render(<Progress value={100} label="本周预算使用" showValue />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('越界与非法值显式抛错，不静默夹紧', () => {
    // 静默夹紧会把上游的计算错误藏起来：用户实际完成 60% 却看到 100%，
    // 而这种「看起来正常」的缺陷最难被发现。
    //
    // React 在渲染期捕获到异常后会先调用 console.error 再重新抛出，
    // 这里抑制那条日志噪音，只断言异常本身。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    for (const value of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => render(<Progress value={value} label="目标进度" />)).toThrow(RangeError);
    }

    consoleError.mockRestore();
  });

  it('不带 showValue 时不渲染百分比文字', () => {
    render(<Progress value={35} label="行动完成进度" />);

    expect(screen.getByRole('progressbar', { name: '行动完成进度' })).toBeInTheDocument();
    expect(screen.queryByText('35%')).toBeNull();
  });
});
