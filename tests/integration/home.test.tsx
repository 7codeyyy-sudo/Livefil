/**
 * 页面冒烟测试（FND-003）。
 *
 * 这是 `integration` project 的冒烟用例：验证 JSX 转换、jsdom 环境、
 * React Testing Library 与 jest-dom 断言扩展这一整条链路是通的。
 * 断言只针对用户可见的语义，不绑定具体 DOM 结构——
 * 后者会让 UI 重构无谓地打断测试。
 *
 * ── UI-003 换过一次被测对象 ──────────────────────────────────────────────
 *
 * 原先渲染的是 `app/page.tsx`（FND-001 的占位首页）。而 `/` 从 UI-003 起
 * 重定向到 `/today`，那个占位页已不再渲染任何内容——它现在是个存根。
 *
 * 冒烟用例因此改指向今日页：它测的是**测试链路**是否通，不是某一页的
 * 内容，所以换一个"确实会渲染东西"的组件即可，无需为它保留一个假页面。
 * （UI-004 起今日页本身也从占位页变成了取数状态页，下面的第二条断言随之更新。）
 * 「`/` 确实会重定向到 `/today`」由浏览器端用例验证
 * （`tests/e2e/home.spec.ts`），那才是能真实观察重定向的地方——
 * 在 jsdom 里调用 `redirect()` 只会抛出框架内部信号，断言它等于把测试
 * 绑在框架实现上。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToastProvider } from '@/shared/ui/components';
import TodayPage from '../../app/(app)/today/page';

describe('页面冒烟', () => {
  it('页面标题渲染为一级标题', () => {
    render(
      <ToastProvider>
        <TodayPage />
      </ToastProvider>,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('今日');
  });

  it('渲染真实状态区，而不是「建设中」占位', () => {
    render(
      <ToastProvider>
        <TodayPage />
      </ToastProvider>,
    );

    // UI-004 起今日页是**真实状态页**（客户端取数 + 四态容器），不再是占位页。
    // 反向断言「没有建设中」正是这次交付的内容：占位被真实状态取代。
    expect(screen.queryByText('建设中')).toBeNull();

    // 初始必为加载态——取数尚未返回。这条不依赖网络结果，所以在 jsdom 里稳定：
    // 请求失败或成功都发生在 effect 之后，而首次渲染一定是 loading。
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });
});
