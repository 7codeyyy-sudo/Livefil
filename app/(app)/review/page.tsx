import type { Metadata } from 'next';

import { PlaceholderPage } from '../_components/PlaceholderPage';

export const metadata: Metadata = { title: '复盘' };

/** 复盘页（`/review`）。真实内容属 REVIEW-001 ~ REVIEW-003。 */
export default function ReviewPage() {
  return <PlaceholderPage title="复盘" note="日复盘与周复盘汇总将在 REVIEW 系列任务交付。" />;
}
