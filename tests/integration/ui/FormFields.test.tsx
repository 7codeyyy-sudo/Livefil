/**
 * Input / Select / Textarea 的行为测试（UI-002 批次 1）。
 *
 * 三个字段组件共享同一套无障碍契约（label 关联、错误播报、说明关联），
 * 因此放在一个文件里测：契约一旦改动，用例会一起提醒，而不是散在三个
 * 文件里各改一半。
 *
 * 样式与几何量不在这里断言——归 `tests/e2e/styleguide.spec.ts`。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Input, Select, Textarea } from '@/shared/ui/components';

/**
 * 断言 `aria-describedby` 指向的每个 id 都真实存在。
 *
 * 指向不存在的 id 时读屏软件会读到空内容——比不指更糟，而且完全静默。
 */
function expectDescribedByTargetsExist(element: HTMLElement): string[] {
  const ids = (element.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);

  for (const id of ids) {
    expect(document.getElementById(id), `aria-describedby 指向的 #${id} 应真实存在`).not.toBeNull();
  }

  return ids;
}

describe('Input', () => {
  it('label 与控件通过 htmlFor/id 关联', () => {
    render(<Input label="任务名称" />);

    // 能用 label 文本查到控件，就证明关联真的接上了（而不是两个并排的元素）。
    expect(screen.getByLabelText('任务名称')).toBeInTheDocument();
  });

  it('错误以 role="alert" 播报，并与控件建立关联', () => {
    render(<Input label="金额" error="请输入大于 0 的金额" />);

    const input = screen.getByLabelText('金额');

    expect(input).toHaveAttribute('aria-invalid', 'true');

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('请输入大于 0 的金额');

    // 关联必须指向真实的错误元素——这条是「错误信息能被读到」的实质。
    expect(expectDescribedByTargetsExist(input)).toHaveLength(1);
    expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')).toBe(alert);
  });

  it('hint 与 error 同时存在时都被登记进 aria-describedby', () => {
    render(<Input label="金额" hint="单位：元" error="金额格式不正确" />);

    const input = screen.getByLabelText('金额');
    const ids = expectDescribedByTargetsExist(input);

    expect(ids).toHaveLength(2);
    expect(screen.getByText('单位：元')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('金额格式不正确');
  });

  it('无错误时不渲染 alert，也不标记无效', () => {
    render(<Input label="任务名称" />);

    const input = screen.getByLabelText('任务名称');

    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('可以正常输入', async () => {
    const user = userEvent.setup();
    render(<Input label="任务名称" />);

    const input = screen.getByLabelText('任务名称');
    await user.type(input, '整理开销');

    expect(input).toHaveValue('整理开销');
  });

  it('disabled 时不可输入', async () => {
    const user = userEvent.setup();
    render(<Input label="任务名称" disabled />);

    const input = screen.getByLabelText('任务名称');
    expect(input).toBeDisabled();

    await user.type(input, 'x');

    expect(input).toHaveValue('');
  });
});

describe('Select', () => {
  it('用原生 select，label 可查到且选项可选', async () => {
    const user = userEvent.setup();
    render(
      <Select label="所属领域" defaultValue="work">
        <option value="work">工作</option>
        <option value="life">生活</option>
      </Select>,
    );

    const select = screen.getByLabelText('所属领域');
    expect(select.tagName).toBe('SELECT');

    await user.selectOptions(select, 'life');
    expect(select).toHaveValue('life');
  });

  it('错误态与 Input 遵循同一契约', () => {
    render(
      <Select label="分类" error="请选择分类">
        <option value="">请选择</option>
      </Select>,
    );

    const select = screen.getByLabelText('分类');

    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(expectDescribedByTargetsExist(select)).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('请选择分类');
  });
});

describe('Textarea', () => {
  it('label 关联、可多行输入', async () => {
    const user = userEvent.setup();
    render(<Textarea label="复盘备注" />);

    const textarea = screen.getByLabelText('复盘备注');
    expect(textarea.tagName).toBe('TEXTAREA');

    await user.type(textarea, '第一行{enter}第二行');
    expect(textarea).toHaveValue('第一行\n第二行');
  });

  it('rows 可覆盖，默认 3 行', () => {
    const { rerender } = render(<Textarea label="复盘备注" />);
    expect(screen.getByLabelText('复盘备注')).toHaveAttribute('rows', '3');

    rerender(<Textarea label="复盘备注" rows={6} />);
    expect(screen.getByLabelText('复盘备注')).toHaveAttribute('rows', '6');
  });

  it('错误态与 Input 遵循同一契约', () => {
    render(<Textarea label="阻碍" error="请至少写 10 个字" />);

    const textarea = screen.getByLabelText('阻碍');

    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(expectDescribedByTargetsExist(textarea)).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('请至少写 10 个字');
  });
});
