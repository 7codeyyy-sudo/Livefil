'use client';

import { Skeleton } from '@/shared/ui/components';

import { PageQuerySection } from '../_components/PageQuerySection';
import stateStyles from '../_components/StatePage.module.css';
import { REVIEW_QUERY } from '../_lib/queries';

/** 与「日复盘」同形的轮廓：一行标题 + 三行正文。 */
function ReviewSkeleton() {
  return (
    <div className={stateStyles.skeleton}>
      <Skeleton width="35%" />
      <Skeleton />
      <Skeleton width="85%" />
      <Skeleton width="60%" />
    </div>
  );
}

/**
 * 复盘页的取数区（UI-004）。
 *
 * ## 空判据与另外四页不同
 *
 * 日复盘返回的是**单个对象而不是列表**，所以空态不能靠「数组长度为 0」判断。
 * `REVIEW_QUERY.isEmpty` 把它定义为 `data === null`——「这天还没复盘」是
 * **成功但没有内容**，与「取数失败」必须分开：只有失败才走错误态。
 *
 * ⚠️ 接口文档目前没有写明「当日无复盘」的响应形状（见 `_lib/queries.ts` 的
 * 记债）。本批按 `data: null` 实现，若 SYNC-001 最终定为别的形状，改那一处判据即可。
 */
export function ReviewPanel() {
  return (
    <PageQuerySection
      query={REVIEW_QUERY}
      errorTitle="复盘没能加载"
      errorDescription="数据没能取回来。可以先重试。"
      skeleton={<ReviewSkeleton />}
      empty={{
        title: '这天还没有复盘',
        description: '复盘用几分钟记下今天的进展和卡点，过段时间回看能看出自己的节奏。',
      }}
      renderSuccess={() => null}
    />
  );
}
