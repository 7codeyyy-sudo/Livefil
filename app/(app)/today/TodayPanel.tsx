'use client';

import Link from 'next/link';

import { Skeleton } from '@/shared/ui/components';

import { PageQuerySection } from '../_components/PageQuerySection';
import stateStyles from '../_components/StatePage.module.css';
import { TODAY_QUERY } from '../_lib/queries';

/** 与「今日任务列表」同形的轮廓：一行标题 + 两行内容。 */
function TodaySkeleton() {
  return (
    <div className={stateStyles.skeleton}>
      <Skeleton width="40%" />
      <Skeleton />
      <Skeleton width="80%" />
    </div>
  );
}

/**
 * 今日页的取数区（UI-004）。
 *
 * ## 空态的操作为什么是一个链接
 *
 * 「今天还没有安排」的下一步是**去收件箱挑一件**——那是一次导航，不是一次
 * 动作，所以用 `<Link>`（真的 `<a>`：可中键新开、可复制地址、读屏识别为链接）。
 * 目标 `/inbox` 是 UI-003 已交付的真实路由，不是占位。
 *
 * 这里**不出现**「新建任务」：快速添加属 TASK-002，尚未存在。§4.7 明确
 * 「空操作槽留空，不放假按钮」——一个点了没反应的按钮比没有按钮更糟。
 */
export function TodayPanel() {
  return (
    <PageQuerySection
      query={TODAY_QUERY}
      errorTitle="今日安排没能加载"
      errorDescription="数据没能取回来。可以先重试。"
      skeleton={<TodaySkeleton />}
      empty={{
        title: '今天还没有安排',
        description: '从收件箱挑一件开始，把要做的事放进今天。',
        action: (
          <Link href="/inbox" className={stateStyles.actionLink}>
            去收件箱
          </Link>
        ),
      }}
      // 本批没有真实数据源，非空分支不可达；UI-007 在这里渲染时间线与任务。
      renderSuccess={() => null}
    />
  );
}
