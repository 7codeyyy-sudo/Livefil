import type { Metadata } from 'next';

import { PlaceholderPage } from '../_components/PlaceholderPage';

export const metadata: Metadata = { title: '收件箱' };

/** 收件箱页（`/inbox`）。真实内容属 UI-005 与 TASK-002。 */
export default function InboxPage() {
  return <PlaceholderPage title="收件箱" note="收件箱列表与快速添加入口将在 UI-005 交付。" />;
}
