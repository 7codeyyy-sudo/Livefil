/**
 * 应用外壳的结构与无障碍测试（UI-003）。
 *
 * 这一层能测到**结构与状态**：导航清单与渲染一致、`aria-current` 的唯一性与
 * 迁移、汉堡与抽屉的 ARIA 关联、抽屉的对话语义与可访问名称、ESC 与遮罩关闭、
 * 关闭后焦点归还、延迟卸载。
 *
 * 测不到的：三档几何量、`::first-letter` 的首字折叠、横向溢出——
 * 那些归 `tests/e2e/app-shell.spec.ts`（真实浏览器；jsdom 没有布局引擎，
 * 媒体查询也不生效）。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '@/shared/ui/layout/AppShell/AppShell';
import { NAV_DRAWER_ID } from '@/shared/ui/layout/MobileNavDrawer/MobileNavDrawer';
import { NAV_ITEMS, PRIMARY_NAV_ITEMS, SETTINGS_NAV_ITEM } from '@/shared/ui/layout/nav-items';

/**
 * `usePathname` 的可变打桩值。
 *
 * 必须用 `vi.hoisted`：`vi.mock` 的工厂会被提升到文件顶部，工厂里直接引用
 * 普通模块级变量会撞暂时性死区（TDZ）。
 */
const router = vi.hoisted(() => ({ pathname: '/today' }));

vi.mock('next/navigation', () => ({
  usePathname: () => router.pathname,
  // 顶栏「＋快速添加」（UI-005 起）用 `useRouter().push('/inbox#quick-add')`
  // 接线；集成层不给真路由，只保证 hook 存在——push 的行为由浏览器端
  // （phase3-ui.spec）覆盖。
  useRouter: () => ({ push: vi.fn() }),
}));

/**
 * `next/link` 在 App Router 上下文之外会去找 router context，而这里要断言的
 * 只是「渲染成链接、`href` 与 `aria-current` 正确」。真实 `<Link>` 的客户端
 * 导航行为由浏览器端用例覆盖——那一层才有真的 router。
 *
 * 替身**刻意不真的导航**（`preventDefault`）：jsdom 没有路由，点 `<a href>`
 * 只会打印一条 "Not implemented: navigation"。但 `onClick` 照常透传——
 * 本文件里有用例要断言的正是「点击会通知调用方关闭抽屉」这条连线。
 */
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        event.preventDefault();
        rest.onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));

/** 滚动锁会改 `document.body`，用例之间必须复位，否则互相污染。 */
afterEach(() => {
  document.body.style.overflow = '';
});

beforeEach(() => {
  router.pathname = '/today';
});

/** 带 `aria-current="page"` 的链接。断言"唯一当前项"时反复用到。 */
function currentLinks(): HTMLElement[] {
  return screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
}

/** 遮罩没有语义角色，用它的 data 属性精确定位（类名带哈希，测试不该依赖）。 */
function scrim(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-overlay-scrim="true"]');

  if (element === null) {
    throw new Error('当前没有渲染遮罩');
  }

  return element;
}

/** 打开抽屉并返回汉堡按钮与面板。 */
async function openNav(): Promise<{ toggle: HTMLElement; drawer: HTMLElement }> {
  const user = userEvent.setup();
  const toggle = screen.getByRole('button', { name: '切换导航' });

  await user.click(toggle);

  return { toggle, drawer: await screen.findByRole('dialog', { name: '站点导航' }) };
}

describe('AppShell · 导航清单与当前页', () => {
  it('主导航按清单渲染，设置项单列指向自己的路由', () => {
    render(<AppShell>内容</AppShell>);

    const nav = screen.getByRole('navigation', { name: '主导航' });

    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(PRIMARY_NAV_ITEMS.map((item) => item.label));

    // 「设置」不在主导航 landmark 内，但同样是真实链接（指向真实路由）。
    expect(screen.getByRole('link', { name: SETTINGS_NAV_ITEM.label })).toHaveAttribute(
      'href',
      SETTINGS_NAV_ITEM.href,
    );

    // 清单本身是单一来源，六个入口一个不少。
    expect(NAV_ITEMS).toHaveLength(6);
  });

  it('导航文字始终留在 DOM 里（首字折叠是纯 CSS，不能靠删节点实现）', () => {
    render(<AppShell>内容</AppShell>);

    // 折叠档用 `font-size: 0` 隐藏文字、再放回首字。它成立的前提是
    // **标签文字没有被从 DOM 里拿掉**——读屏读到的仍是完整名称。
    expect(screen.getByRole('link', { name: '收件箱' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '复盘' })).toBeInTheDocument();
  });

  it('当前页标记唯一，且随路由迁移', () => {
    router.pathname = '/goals';
    const first = render(<AppShell>内容</AppShell>);

    expect(currentLinks().map((link) => link.textContent)).toEqual(['目标']);

    first.unmount();

    router.pathname = '/review';
    render(<AppShell>内容</AppShell>);

    expect(currentLinks().map((link) => link.textContent)).toEqual(['复盘']);
  });

  it('未知路由下没有任何一项被标为当前页', () => {
    router.pathname = '/不存在的路径';
    render(<AppShell>内容</AppShell>);

    expect(currentLinks()).toEqual([]);
  });
});

describe('AppShell · 页面区与工具栏', () => {
  it('页面内容落在唯一的 main 地标里', () => {
    render(<AppShell>这里是页面内容</AppShell>);

    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('main')).toHaveTextContent('这里是页面内容');
  });

  it('「＋ 快速添加」是可用入口：不是禁用态，也不带行为', () => {
    render(<AppShell>内容</AppShell>);

    const quickAdd = screen.getByRole('button', { name: /快速添加/ });

    // TASK-002 前它是"挂空入口"：标签完整、可见可聚焦，只是点了没有行为。
    // 断言"未禁用"是刻意的——把它 disable 掉会让人以为功能坏了。
    expect(quickAdd).toBeEnabled();
  });

  it('未给 pageActions 时不渲染操作容器，给了才渲染', () => {
    const first = render(<AppShell>内容</AppShell>);
    expect(screen.queryByRole('button', { name: '今日复盘' })).toBeNull();

    first.unmount();

    render(<AppShell pageActions={<button type="button">今日复盘</button>}>内容</AppShell>);

    expect(screen.getByRole('button', { name: '今日复盘' })).toBeInTheDocument();
  });
});

describe('AppShell · 移动端导航抽屉', () => {
  it('汉堡按钮声明了它与抽屉的关系，且默认收起', () => {
    render(<AppShell>内容</AppShell>);

    const toggle = screen.getByRole('button', { name: '切换导航' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', NAV_DRAWER_ID);
    // 收起时不渲染任何浮层。
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('打开后是有可访问名称的模态对话，并锁住页面滚动', async () => {
    render(<AppShell>内容</AppShell>);

    const { toggle, drawer } = await openNav();

    // 名称来自视觉隐藏的标题——没有它读屏只会听到"对话框"。
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(drawer).toHaveAttribute('id', NAV_DRAWER_ID);
    // 关联是双向的：按钮说得出它控制谁。
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('抽屉里的导航与流式侧栏是同一份清单', async () => {
    render(<AppShell>内容</AppShell>);

    const { drawer } = await openNav();
    const nav = within(drawer).getByRole('navigation', { name: '主导航' });

    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(PRIMARY_NAV_ITEMS.map((item) => item.label));
    expect(within(drawer).getByRole('link', { name: SETTINGS_NAV_ITEM.label })).toBeInTheDocument();
  });

  it('点抽屉里的导航链接会关闭抽屉（不是只切换路由）', async () => {
    const user = userEvent.setup();
    render(<AppShell>内容</AppShell>);

    const { drawer } = await openNav();

    await user.click(within(drawer).getByRole('link', { name: '收件箱' }));

    // 退场动画播完才真正卸载：jsdom 不会自动派发 transitionend，手动补上。
    fireEvent.transitionEnd(drawer);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('抽屉里的品牌链接同样会关闭抽屉（同一缺陷的另一条入口）', async () => {
    const user = userEvent.setup();
    render(<AppShell>内容</AppShell>);

    const { drawer } = await openNav();

    await user.click(within(drawer).getByRole('link', { name: 'Livefil' }));
    fireEvent.transitionEnd(drawer);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('ESC 关闭抽屉，并把焦点归还给汉堡按钮', async () => {
    const user = userEvent.setup();
    render(<AppShell>内容</AppShell>);

    const { toggle, drawer } = await openNav();

    await user.keyboard('{Escape}');

    // 退场动画播完才真正卸载：jsdom 不会自动派发 transitionend，手动补上。
    fireEvent.transitionEnd(drawer);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(toggle).toHaveFocus();
  });

  it('点遮罩关闭；点面板本身不关闭', async () => {
    const user = userEvent.setup();
    render(<AppShell>内容</AppShell>);

    const { drawer } = await openNav();

    // 判据是"事件目标必须就是遮罩"：面板内部的点击会冒泡到遮罩，
    // 但那不该被当成"点遮罩"。
    await user.click(drawer);
    expect(screen.getByRole('dialog', { name: '站点导航' })).toBeInTheDocument();

    await user.click(scrim());
    fireEvent.transitionEnd(drawer);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('关闭态整个移出 DOM（不是留在屏外还能被 Tab 聚焦）', async () => {
    const user = userEvent.setup();
    render(<AppShell>内容</AppShell>);

    const { drawer } = await openNav();

    await user.keyboard('{Escape}');
    fireEvent.transitionEnd(drawer);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // 这正是"复用浮层基建"换来的东西：关闭态没有藏在屏幕外、仍可聚焦的链接。
    expect(document.querySelector(`#${NAV_DRAWER_ID}`)).toBeNull();
  });
});
