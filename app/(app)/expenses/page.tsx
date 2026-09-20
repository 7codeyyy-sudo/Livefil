import type { Metadata } from 'next';

import { PageHeading } from '../_components/PageHeading';
import { ExpensesPanel } from './ExpensesPanel';

export const metadata: Metadata = { title: '开销' };

/**
 * 开销页（`/expenses`）。
 *
 * 本批（UI-004）只交付状态；记账与摘要属 EXP 系列任务。空态描述因此讲的是
 * 「这块区域将来会给出什么」（按月汇总），而不是一个点不动的「记一笔」。
 */
export default function ExpensesPage() {
  return (
    <>
      <PageHeading>开销</PageHeading>
      <ExpensesPanel />
    </>
  );
}
