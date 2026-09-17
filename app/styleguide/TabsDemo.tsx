'use client';

import { useState } from 'react';

import { Tabs } from '@/shared/ui/components';
import type { TabItem } from '@/shared/ui/components';

/**
 * Tabs 的客户端包装（UI-002 批次 2）。
 *
 * ## 为什么单独一个文件，而不是把整个页面改成客户端组件
 *
 * styleguide 页面本身是服务端组件——这是批次 1 刻意保留的，用来证明纯展示组件
 * 能在 RSC 里直接使用。Tabs 是受控组件、需要 `useState`，因此必须落在客户端
 * 边界内；只把需要交互的这一块包起来，边界才是准确的，Badge / Progress
 * 「可以在服务端渲染」这件事也才仍然被验证着。
 */

const ITEMS: readonly TabItem[] = [
  {
    value: 'task',
    label: '任务',
    content: <p>只要求标题，其余字段都可以之后再补。</p>,
  },
  {
    value: 'goal',
    label: '目标',
    content: <p>先写清结果描述，行动可以稍后拆解。</p>,
  },
  {
    value: 'expense',
    label: '开销',
    content: <p>金额优先，分类默认取最近使用的一项。</p>,
  },
];

export function TabsDemo() {
  const [value, setValue] = useState('task');

  return <Tabs items={ITEMS} value={value} onValueChange={setValue} label="添加类型" />;
}
