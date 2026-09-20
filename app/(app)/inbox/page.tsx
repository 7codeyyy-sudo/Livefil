import type { Metadata } from 'next';

import { PageHeading } from '../_components/PageHeading';
import { InboxPanel } from './InboxPanel';

export const metadata: Metadata = { title: '收件箱' };

/**
 * 收件箱页（`/inbox`）。
 *
 * 本批（UI-004）只交付**状态**：加载中、取数失败与「收件箱为空」。列表、
 * 快速添加输入框与批量安排属 UI-005——所以这里看不到任何条目渲染，
 * 那正是「本批不做列表」的体现，而不是漏掉了。
 *
 * 页面本身保持服务端组件：只有取数区（`InboxPanel`）是客户端边界，
 * 因为取数按 §4.7 走客户端。
 */
export default function InboxPage() {
  return (
    <>
      <PageHeading>收件箱</PageHeading>
      <InboxPanel />
    </>
  );
}
