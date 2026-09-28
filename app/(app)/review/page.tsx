import type { Metadata } from 'next';

import { PageHeading } from '../_components/PageHeading';
import { ReviewPanel } from './ReviewPanel';

export const metadata: Metadata = { title: '复盘' };

/**
 * 复盘页（`/review`，REVIEW-001~003）。
 *
 * 服务端只给页头与分段容器：日复盘 / 周复盘各自取数、各自持有草稿（见
 * `ReviewPanel` 的说明）。这一页的空判据与另外四页不同（日复盘返回的是单个
 * 对象而非列表，且 `data: null` 表示"这天没填写"而非空列表），细节在
 * `DailyReviewSection` 与 `_lib/review-api.ts` 里。
 */
export default function ReviewPage() {
  return (
    <>
      <PageHeading>复盘</PageHeading>
      <ReviewPanel />
    </>
  );
}
