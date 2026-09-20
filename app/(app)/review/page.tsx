import type { Metadata } from 'next';

import { PageHeading } from '../_components/PageHeading';
import { ReviewPanel } from './ReviewPanel';

export const metadata: Metadata = { title: '复盘' };

/**
 * 复盘页（`/review`）。
 *
 * 本批（UI-004）只交付状态；日复盘与周复盘的填写与汇总属 REVIEW 系列任务。
 * 这一页的空判据与另外四页不同（返回的是单个对象而非列表），细节见
 * `ReviewPanel` 与 `_lib/queries.ts`。
 */
export default function ReviewPage() {
  return (
    <>
      <PageHeading>复盘</PageHeading>
      <ReviewPanel />
    </>
  );
}
