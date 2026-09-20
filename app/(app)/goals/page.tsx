import type { Metadata } from 'next';

import { PageHeading } from '../_components/PageHeading';
import { GoalsPanel } from './GoalsPanel';

export const metadata: Metadata = { title: '目标' };

/**
 * 目标页（`/goals`）。
 *
 * 本批（UI-004）只交付状态；目标列表与详情属 UI-006，创建与编辑属 GOAL-001。
 * 所以空态的「下一步」是一条**认知指引**（先想清楚要改变什么），而不是
 * 一个还不存在的「新建目标」按钮。
 */
export default function GoalsPage() {
  return (
    <>
      <PageHeading>目标</PageHeading>
      <GoalsPanel />
    </>
  );
}
