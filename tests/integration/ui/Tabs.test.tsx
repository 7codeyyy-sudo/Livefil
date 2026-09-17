/**
 * Tabs 的行为测试（UI-002 批次 2）。
 *
 * 键盘与 ARIA 是这一层的重点：标签栏的可用性几乎完全由这两件事决定，
 * 而它们在浏览器里靠肉眼看不出来。几何量（分段控件高度、激活项阴影）
 * 归 `tests/e2e/styleguide.spec.ts`。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Tabs } from '@/shared/ui/components';

const ITEMS = [
  { value: 'task', label: '任务', content: <p>任务面板</p> },
  { value: 'goal', label: '目标', content: <p>目标面板</p> },
  { value: 'expense', label: '开销', content: <p>开销面板</p> },
] as const;

/**
 * 受控包装。
 *
 * 键盘导航的断言必须跑在**真的会更新 value** 的宿主上：如果 value 恒定不变，
 * 每次方向键都会从同一个 selectedIndex 出发，「下一项」就永远算不出来——
 * 那样测到的是测试替身的行为，不是组件的。
 */
function ControlledTabs({ initialValue = 'task' }: { readonly initialValue?: string }) {
  const [value, setValue] = useState(initialValue);

  return <Tabs items={ITEMS} value={value} onValueChange={setValue} label="添加类型" />;
}

describe('Tabs · 结构', () => {
  it('标签栏有名称，且标签数量与 items 一致', () => {
    render(<ControlledTabs />);

    const list = screen.getByRole('tablist', { name: '添加类型' });

    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(ITEMS.length);
  });

  it('有且仅有一个选中项', () => {
    render(<ControlledTabs initialValue="goal" />);

    expect(screen.getByRole('tab', { name: '目标' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '任务' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: '开销' })).toHaveAttribute('aria-selected', 'false');
  });

  it('标签与面板通过 id 双向关联', () => {
    render(<ControlledTabs />);

    const tab = screen.getByRole('tab', { name: '任务' });
    const panelId = tab.getAttribute('aria-controls');

    expect(panelId).toBeTruthy();

    const panel = document.getElementById(panelId ?? '');

    // aria-controls 指向不存在的元素是无效引用——这条断言防止 id 规则漂移。
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
  });

  it('未选中的面板仍然挂载（切回来时用户填的内容还在）', () => {
    render(<ControlledTabs />);

    // 全部三个面板都在 DOM 里，只是隐藏——用条件渲染会让「添加」弹窗
    // 来回切类型时丢掉用户已经填好的字段。
    expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(ITEMS.length);
    // 可见的只有一个
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });
});

describe('Tabs · 键盘', () => {
  it('roving tabindex：只有选中项可被 Tab 键到达', () => {
    render(<ControlledTabs />);

    // 否则键盘用户要按 N 次 Tab 才能穿过标签栏——标签越多越糟。
    expect(screen.getByRole('tab', { name: '任务' })).toHaveAttribute('tabindex', '0');
    for (const name of ['目标', '开销']) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('tabindex', '-1');
    }
  });

  it('点击标签切换面板', async () => {
    const user = userEvent.setup();
    render(<ControlledTabs />);

    await user.click(screen.getByRole('tab', { name: '目标' }));

    expect(screen.getByRole('tab', { name: '目标' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('目标面板');
  });

  it('方向键切换选中项，且两端回绕', async () => {
    const user = userEvent.setup();
    render(<ControlledTabs />);

    const tab = (name: string) => screen.getByRole('tab', { name });

    tab('任务').focus();

    await user.keyboard('{ArrowRight}');
    expect(tab('目标')).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowRight}');
    expect(tab('开销')).toHaveAttribute('aria-selected', 'true');

    // 末项继续右移回绕到首项——键盘操作不留死角（§7）
    await user.keyboard('{ArrowRight}');
    expect(tab('任务')).toHaveAttribute('aria-selected', 'true');

    // 首项继续左移回绕到末项
    await user.keyboard('{ArrowLeft}');
    expect(tab('开销')).toHaveAttribute('aria-selected', 'true');
  });

  it('Home / End 跳到两端', async () => {
    const user = userEvent.setup();
    render(<ControlledTabs initialValue="goal" />);

    screen.getByRole('tab', { name: '目标' }).focus();

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: '开销' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: '任务' })).toHaveAttribute('aria-selected', 'true');
  });

  it('不响应无关按键', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(<Tabs items={ITEMS} value="task" onValueChange={onValueChange} label="添加类型" />);

    screen.getByRole('tab', { name: '任务' }).focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('a');

    // 纵向方向键与字符键不该改变选中项：这是水平 tablist，
    // 而「按下字母就跳转」是另一个组件的交互模型，混进来只会让人意外。
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe('Tabs · 契约校验', () => {
  it('受控值不在 items 中时显式抛错', () => {
    // 静默失败的表现是「所有标签都没选中」——违反 ARIA 对 tablist 的硬要求，
    // 且只有读屏用户会发现。React 会先 console.error 再重新抛出，抑制那条噪音。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() =>
      render(
        <Tabs items={ITEMS} value="unknown" onValueChange={() => undefined} label="添加类型" />,
      ),
    ).toThrow(/unknown/);

    consoleError.mockRestore();
  });
});
