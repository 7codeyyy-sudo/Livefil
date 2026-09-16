/**
 * 首页组件测试（FND-003）。
 *
 * 这是 `integration` project 的冒烟用例：验证 JSX 转换、jsdom 环境、
 * React Testing Library 与 jest-dom 断言扩展这一整条链路是通的。
 * 断言只针对用户可见的语义（标题、正文），不绑定具体 DOM 结构——
 * 后者会让 UI 重构无谓地打断测试。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import HomePage from '../../app/page';

describe('首页', () => {
  it('把产品名渲染为一级标题', () => {
    render(<HomePage />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Livefil');
  });

  it('说明当前仍处于工程骨架阶段', () => {
    render(<HomePage />);

    expect(screen.getByText(/工程骨架已就绪/)).toBeInTheDocument();
  });

  it('默认只渲染一个 main 地标，不重复嵌套', () => {
    render(<HomePage />);

    expect(screen.getAllByRole('main')).toHaveLength(1);
  });
});
