import type { Metadata } from 'next';

import { PlaceholderPage } from '../_components/PlaceholderPage';

export const metadata: Metadata = { title: '今日' };

/** 今日页（`/today`）。真实内容属 UI-007；本批只保证外壳与路由可达。 */
export default function TodayPage() {
  return <PlaceholderPage title="今日" note="今日排程与执行入口将在 UI-007 交付。" />;
}
