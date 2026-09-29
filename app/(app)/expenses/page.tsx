import type { Metadata } from 'next';

import { PageHeading } from '../_components/PageHeading';
import { ExpensesPanel } from './ExpensesPanel';

export const metadata: Metadata = { title: '开销' };

/**
 * 开销页（`/expenses`，EXP-001~004）。
 *
 * 页面本身只管标题与外壳；取数、筛选、记账抽屉、分类管理都在 `ExpensesPanel`
 * 及其子组件里（《UI 页面规范》§5 A1~A6）。
 */
export default function ExpensesPage() {
  return (
    <>
      <PageHeading>开销</PageHeading>
      <ExpensesPanel />
    </>
  );
}
