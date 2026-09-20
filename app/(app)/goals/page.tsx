import type { Metadata } from 'next';

import { PlaceholderPage } from '../_components/PlaceholderPage';

export const metadata: Metadata = { title: '目标' };

/** 目标页（`/goals`）。真实内容属 UI-006 与 GOAL-001 / GOAL-002。 */
export default function GoalsPage() {
  return <PlaceholderPage title="目标" note="目标与行动的展示将在 UI-006 交付。" />;
}
