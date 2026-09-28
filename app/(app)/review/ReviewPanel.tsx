'use client';

import { useState } from 'react';

import { Button } from '@/shared/ui/components';

import { DailyReviewSection } from './DailyReviewSection';
import { WeeklyReviewSection } from './WeeklyReviewSection';

import styles from './ReviewPanel.module.css';

/** 两个分段（B0：默认日复盘）。 */
type Segment = 'daily' | 'weekly';

/**
 * 复盘页（`/review`，REVIEW-001~003，《UI 页面规范》§5 B0~B4）。
 *
 * ## 分段为什么是用 `aria-pressed` 的两枚 Button
 *
 * B0 明文「不新建 Tab 组件范式」：分段在这里只是**同一路由内的视图切换**，不是
 * 导航——两段共用页头、共用「这一周/这一天」的上下文，拆成 Tab 组件要连带引入
 * roving tabindex、方向键切换、面板关联一整套语义，而它的收益在只有两项时为零。
 * 视觉上的「选中态」（surface-soft 底 + text-primary）由容器 CSS 按
 * `[aria-pressed='true']` 给（`Button` 不接收 `className`，也不该为这一处开口子）。
 *
 * ## 切换为什么是卸载而不是隐藏
 *
 * 两段各自取数、各自有草稿状态。切换即卸载，回来时是新的一次取数——这与
 * 「日复盘的已保存内容来自服务端」相合，也避免了两段同时挂着请求。
 */
export function ReviewPanel() {
  const [segment, setSegment] = useState<Segment>('daily');

  return (
    <div className={styles.panel}>
      <div className={styles.segments} role="group" aria-label="复盘类型">
        <Button
          variant="ghost"
          aria-pressed={segment === 'daily'}
          onClick={() => {
            setSegment('daily');
          }}
        >
          日复盘
        </Button>
        <Button
          variant="ghost"
          aria-pressed={segment === 'weekly'}
          onClick={() => {
            setSegment('weekly');
          }}
        >
          周复盘
        </Button>
      </div>

      {segment === 'daily' ? <DailyReviewSection /> : <WeeklyReviewSection />}
    </div>
  );
}
