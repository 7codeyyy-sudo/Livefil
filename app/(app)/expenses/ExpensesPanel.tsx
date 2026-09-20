'use client';

import { Skeleton } from '@/shared/ui/components';

import { PageQuerySection } from '../_components/PageQuerySection';
import stateStyles from '../_components/StatePage.module.css';
import { EXPENSES_QUERY } from '../_lib/queries';

/** 与「开销记录列表」同形的轮廓：三行条目 + 一行汇总。 */
function ExpensesSkeleton() {
  return (
    <div className={stateStyles.skeleton}>
      <Skeleton width="55%" />
      <Skeleton width="90%" />
      <Skeleton width="80%" />
      <Skeleton width="40%" />
    </div>
  );
}

/**
 * 开销页的取数区（UI-004）。
 *
 * 记录与汇总属 EXP-001（尚未交付），所以空态的描述讲的是**这块区域会给出
 * 什么**（按月汇总、服务于月末复盘），而不是一个点不动的「记一笔」按钮。
 */
export function ExpensesPanel() {
  return (
    <PageQuerySection
      query={EXPENSES_QUERY}
      errorTitle="开销没能加载"
      errorDescription="数据没能取回来。可以先重试。"
      skeleton={<ExpensesSkeleton />}
      empty={{
        title: '还没有记录开销',
        description: '这里会按月汇总每一笔支出，月末复盘时用得上。',
      }}
      renderSuccess={() => null}
    />
  );
}
