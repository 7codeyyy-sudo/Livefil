'use client';

import type { ReactNode } from 'react';

import { AsyncState, useAsyncQuery } from '@/shared/ui/components';
import type { EmptyStateProps } from '@/shared/ui/components';

import { fetchJson } from '../_lib/api-client';
import type { ApiEnvelope } from '../_lib/api-client';
import type { PageQuery } from '../_lib/queries';

import styles from './StatePage.module.css';

export type PageQuerySectionProps<T> = {
  /** 查询定义（URL + 空判据），见 `_lib/queries.ts`。 */
  readonly query: PageQuery<T>;
  /** 空态配置：标题、描述与操作槽。 */
  readonly empty: EmptyStateProps;
  /** 错误态标题：各页不同，说清「是什么没能加载」。 */
  readonly errorTitle: string;
  /** 错误态描述：说明现在能做什么。 */
  readonly errorDescription: string;
  /** 加载态骨架轮廓，用 `Skeleton` 组合出与本页内容同形的形状。 */
  readonly skeleton: ReactNode;
  /**
   * 成功且非空时的真实内容。
   *
   * 入参是**整个信封**（不只是 `data`）：分页的游标在 `meta` 里，UI-005 接列表
   * 时要读它。本批五个页面都还没有列表（各自的任务未交付），所以它们的
   * `renderSuccess` 暂时返回 `null`——**不伪造内容**，也不假装已经加载出什么。
   */
  readonly renderSuccess: (envelope: ApiEnvelope<T>) => ReactNode;
};

/**
 * 页面取数区（UI-004，《UI 页面规范》v0.14 §4.7）。
 *
 * ## 它存在的理由
 *
 * 五个页面的取数部分完全同构：把查询定义接到取数原语，再把状态交给四态容器。
 * 这段「接线」写五遍不会带来任何表达力，只会让「取数该怎么发起」有五个版本。
 * 各页真正不同的只有三样东西——**文案、骨架轮廓、成功分支**，它们从 props 进来。
 *
 * ## 它不含任何分支逻辑
 *
 * 四态怎么渲染由 `AsyncState` 决定，这里只负责**发起取数**并把 `refetch`
 * 接到重试上。所以这一层薄到可以一眼看完。
 */
export function PageQuerySection<T>({
  query,
  empty,
  errorTitle,
  errorDescription,
  skeleton,
  renderSuccess,
}: PageQuerySectionProps<T>) {
  const { state, refetch } = useAsyncQuery<ApiEnvelope<T>>({
    queryKey: query.queryKey,
    // queryFn 每次渲染都是新引用，但取数原语用 ref 读最新值、不把它当依赖，
    // 所以这里内联写不会造成重复请求。
    queryFn: (signal) => fetchJson<T>(query.url, signal),
  });

  return (
    <div className={styles.section}>
      <AsyncState
        state={state}
        isEmpty={query.isEmpty}
        renderSuccess={renderSuccess}
        empty={empty}
        errorTitle={errorTitle}
        errorDescription={errorDescription}
        loading={skeleton}
        onRetry={refetch}
      />
    </div>
  );
}
