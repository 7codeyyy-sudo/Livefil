import type { Metadata } from 'next';

import { PlaceholderPage } from '../_components/PlaceholderPage';

export const metadata: Metadata = { title: '开销' };

/** 开销页（`/expenses`）。真实内容属 EXP-002 ~ EXP-004。 */
export default function ExpensesPage() {
  return <PlaceholderPage title="开销" note="快速记账与开销摘要将在 EXP 系列任务交付。" />;
}
