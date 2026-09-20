'use client';

import { Skeleton } from '@/shared/ui/components';

import { PageQuerySection } from '../_components/PageQuerySection';
import stateStyles from '../_components/StatePage.module.css';
import { INBOX_QUERY } from '../_lib/queries';

/** 与「收件箱列表」同形的轮廓：四行条目。 */
function InboxSkeleton() {
  return (
    <div className={stateStyles.skeleton}>
      <Skeleton />
      <Skeleton width="90%" />
      <Skeleton width="95%" />
      <Skeleton width="70%" />
    </div>
  );
}

/**
 * 收件箱页的取数区（UI-004）。
 *
 * ## 本批只做状态，不做列表
 *
 * 列表、快速添加输入框与批量安排都属 **UI-005**。所以：
 *
 * - 空态与加载态是真的（这里就是它们的最终形态）；
 * - **成功非空分支返回 `null`**，是明确的占位而不是疏忽——本批没有任务数据源，
 *   这个分支在真实运行下不可达，它的存在是为了让四态在类型与代码上闭合。
 *   UI-005 把 `renderSuccess` 换成真实列表即可，其余一行不用动。
 *
 * 空态同样**不给操作**：记录入口（快速添加）属 TASK-002，尚无。描述只陈述
 * 「新任务会先落在这里」这一机制，不承诺任何还不存在的按钮。
 */
export function InboxPanel() {
  return (
    <PageQuerySection
      query={INBOX_QUERY}
      errorTitle="收件箱没能加载"
      errorDescription="数据没能取回来。可以先重试。"
      skeleton={<InboxSkeleton />}
      empty={{
        title: '收件箱是空的',
        description: '新记下的任务会先落在这里，之后再安排到具体的时间。',
      }}
      renderSuccess={() => null}
    />
  );
}
