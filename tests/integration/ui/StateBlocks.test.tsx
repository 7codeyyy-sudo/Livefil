/**
 * 页面状态组件的行为测试（UI-002 批次 4，《UI 页面规范》v0.11 §4.6）。
 *
 * 这一层测的是**结构与语义**：ARIA、槽位的有无、内联尺寸与令牌类的分工。
 * 视觉（虚线框、骨架底色、无循环动画、危险色）归
 * `tests/e2e/styleguide.spec.ts`——jsdom 不解析 CSS。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button, EmptyState, ErrorState, LoadingState, Skeleton } from '@/shared/ui/components';

describe('EmptyState · 结构与槽位', () => {
  it('渲染标题与描述', () => {
    render(<EmptyState title="这里还没有内容" description="先记录一件小事。" />);

    expect(screen.getByText('这里还没有内容')).toBeInTheDocument();
    expect(screen.getByText('先记录一件小事。')).toBeInTheDocument();
  });

  it('两个槽都不给时不渲染任何操作', () => {
    render(<EmptyState title="空" description="说明" />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('给了槽就渲染出真实按钮（含两个槽同时给）', () => {
    render(
      <EmptyState
        title="空"
        description="说明"
        action={<Button>新建任务</Button>}
        secondaryAction={<Button>了解做法</Button>}
      />,
    );

    expect(screen.getByRole('button', { name: '新建任务' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '了解做法' })).toBeInTheDocument();
  });

  it('只给主操作槽也能渲染', () => {
    render(<EmptyState title="空" description="说明" action={<Button>新建任务</Button>} />);

    expect(screen.getByRole('button', { name: '新建任务' })).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(1);
  });

  it('不擅自使用标题标签（避免打乱页面大纲）', () => {
    render(<EmptyState title="这里还没有内容" description="先记录一件小事。" />);

    expect(screen.queryByRole('heading')).toBeNull();
  });
});

describe('ErrorState · 语义与槽位', () => {
  it('语义是 alert（阻塞态插入即被播报）', () => {
    render(<ErrorState title="加载失败" description="请重试。" action={<Button>重试</Button>} />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('标题与描述都渲染', () => {
    render(
      <ErrorState
        title="内容没能加载出来"
        description="可能是网络不稳定。"
        action={<Button>重试</Button>}
      />,
    );

    expect(screen.getByText('内容没能加载出来')).toBeInTheDocument();
    expect(screen.getByText('可能是网络不稳定。')).toBeInTheDocument();
  });

  it('主操作槽有内容时渲染出来', () => {
    render(<ErrorState title="加载失败" description="请重试。" action={<Button>重试</Button>} />);

    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('不给次要操作时只渲染主操作一个按钮', () => {
    render(<ErrorState title="加载失败" description="请重试。" action={<Button>重试</Button>} />);

    expect(screen.queryAllByRole('button')).toHaveLength(1);
  });

  it('给次要操作时两个都渲染', () => {
    render(
      <ErrorState
        title="加载失败"
        description="请重试。"
        action={<Button>重试</Button>}
        secondaryAction={<Button>返回首页</Button>}
      />,
    );

    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回首页' })).toBeInTheDocument();
  });

  it('图标对读屏隐藏（它是装饰，语义由 alert + 文字承担）', () => {
    const { container } = render(
      <ErrorState title="加载失败" description="请重试。" action={<Button>重试</Button>} />,
    );

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('LoadingState · 加载语义', () => {
  it('role=status 且 aria-busy=true', () => {
    render(<LoadingState />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
  });

  it('默认带视觉隐藏的加载说明', () => {
    render(<LoadingState />);

    expect(screen.getByText('正在加载…')).toBeInTheDocument();
  });

  it('加载说明可自定义（领域化文案是常态）', () => {
    render(<LoadingState label="正在载入本周开销…" />);

    expect(screen.getByText('正在载入本周开销…')).toBeInTheDocument();
    expect(screen.queryByText('正在加载…')).toBeNull();
  });

  it('接收骨架作为 children', () => {
    render(
      <LoadingState>
        <Skeleton width="60%" />
        <Skeleton width="100%" />
      </LoadingState>,
    );

    const status = screen.getByRole('status');
    expect(status.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(2);
  });
});

describe('Skeleton · 组合原语', () => {
  it('对读屏隐藏（纯视觉占位）', () => {
    const { container } = render(<Skeleton />);

    const element = container.firstElementChild;
    expect(element).not.toBeNull();
    expect(element?.getAttribute('aria-hidden')).toBe('true');
  });

  it('宽高走内联样式，圆角不走内联（设计取值只来自样式类里的令牌）', () => {
    const { container } = render(<Skeleton width="40%" height="2em" />);

    const style = container.firstElementChild?.getAttribute('style') ?? '';
    expect(style).toContain('width: 40%');
    expect(style).toContain('height: 2em');
    // 圆角若写成内联的数字，会直接撞上纪律扫描——这里守住这条边界
    expect(style).not.toContain('border-radius');
  });

  it('不传尺寸时不产生多余的内联样式', () => {
    const { container } = render(<Skeleton />);

    const style = container.firstElementChild?.getAttribute('style') ?? '';
    expect(style).not.toContain('width');
    expect(style).not.toContain('height');
  });
});
