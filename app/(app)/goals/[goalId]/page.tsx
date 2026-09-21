import type { Metadata } from 'next';

import { GoalDetailPanel } from './GoalDetailPanel';

export const metadata: Metadata = { title: '目标详情' };

/**
 * 目标详情（UI-006，`/goals/[goalId]`）。
 *
 * 落点定档（2026-09-21）：**独立路由**而非侧边抽屉——详情页承载行动列表、
 * 双进度与新增行动，抽屉装不下；独立路由也带来直链与刷新保持。
 */
export default async function GoalDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly goalId: string }>;
}) {
  const { goalId } = await params;
  return <GoalDetailPanel goalId={goalId} />;
}
