'use client';

import { Skeleton } from '@/shared/ui/components';

import { PageQuerySection } from '../_components/PageQuerySection';
import stateStyles from '../_components/StatePage.module.css';
import { GOALS_QUERY } from '../_lib/queries';

/** 与「目标卡片列表」同形的轮廓：两个块，各带一行标题与一行说明。 */
function GoalsSkeleton() {
  return (
    <div className={stateStyles.skeleton}>
      <Skeleton width="45%" />
      <Skeleton width="85%" />
      <Skeleton width="35%" />
      <Skeleton width="75%" />
    </div>
  );
}

/**
 * 目标页的取数区（UI-004）。
 *
 * 目标的创建与编辑属 GOAL-001，列表与详情属 UI-006，都还没交付。所以空态的
 * 描述只讲清**目标是什么、想清楚才有用**这件事——它是一个真实的认知步骤，
 * 不需要任何按钮就能做；而「新建目标」按钮要等 GOAL-001。
 */
export function GoalsPanel() {
  return (
    <PageQuerySection
      query={GOALS_QUERY}
      errorTitle="目标没能加载"
      errorDescription="数据没能取回来。可以先重试。"
      skeleton={<GoalsSkeleton />}
      empty={{
        title: '还没有目标',
        description: '目标是一段时期里想推进的方向。先想清楚要改变什么，再把它拆成能落地的行动。',
      }}
      renderSuccess={() => null}
    />
  );
}
