import type { Metadata } from 'next';

import { PageHeading } from '../_components/PageHeading';
import { WeekPanel } from './WeekPanel';

export const metadata: Metadata = { title: '本周' };

/** 周视图（SCHED-003 P0 最小集：只读七日网格，UI v0.20 §5）。 */
export default function WeekPage() {
  return (
    <>
      <PageHeading>本周</PageHeading>
      <WeekPanel />
    </>
  );
}
