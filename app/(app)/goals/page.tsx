import type { Metadata } from 'next';

import { PageHeading } from '../_components/PageHeading';
import { GoalsPanel } from './GoalsPanel';

export const metadata: Metadata = { title: '目标' };

/**
 * 目标页（`/goals`，UI-006）。
 *
 * 列表与新建目标见 {@link GoalsPanel}；详情在独立路由 `/goals/[goalId]`。
 */
export default function GoalsPage() {
  return (
    <>
      <PageHeading>目标</PageHeading>
      <GoalsPanel />
    </>
  );
}
