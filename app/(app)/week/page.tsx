import type { Metadata } from 'next';

import { PageHeading } from '../_components/PageHeading';
import { WeekPanel } from './WeekPanel';

export const metadata: Metadata = { title: '周视图' };

/**
 * 周视图（`/week`，SCHED-003 P0 最小集，UI v0.20 §5）。
 *
 * ## 为什么标题是「周视图」而不是「本周」
 *
 * 本页自 REVIEW-003 增量起可显示**任意一周**（`?weekStart=`），「本周」这个页名
 * 从那时起就只对其中一周成立。页面名取冻结文档里这一节的名称（UI 规范 §5
 * 「周视图」），与"当前显示哪一周"解耦——显示范围由 `WeekPanel` 的周范围文案承担。
 *
 * ## 为什么 `weekStart` 走 `searchParams` 而不是客户端 `useSearchParams`
 *
 * 服务端读一次就能把它作为 prop 传下去，页面不必为了一个查询参数退化成客户端
 * 渲染边界（`useSearchParams` 还需要 Suspense 包裹）。取值合法性由 `WeekPanel`
 * 判定：它才知道用户的 `weekStartsOn`（对齐周起点要用）。
 */
export default async function WeekPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | readonly string[] | undefined>>>;
}) {
  const params = await searchParams;
  const requested = params['weekStart'];

  return (
    <>
      <PageHeading>周视图</PageHeading>
      <WeekPanel requestedWeekStart={typeof requested === 'string' ? requested : ''} />
    </>
  );
}
