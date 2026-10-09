import type { Metadata } from 'next';

import { PageHeading } from '../_components/PageHeading';
import { TodayPanel } from './TodayPanel';

export const metadata: Metadata = { title: '今日' };

/**
 * 今日页（`/today`）。
 *
 * 本批（UI-004）只交付状态：加载中、取数失败与「今天还没有安排」。时间线与
 * 任务内容属 UI-007。
 *
 * 空态这里**有一个真操作**：链接到 `/inbox`。它是 UI-003 已交付的真实路由，
 * 也是「今天没安排时该做什么」这个问题的真实答案——而不是一个占位按钮。
 *
 * 新手引导（AI-007，UI v0.25「新手引导形态升版补节」）**不在本页渲染**：载体是
 * 挂在 `(app)` 外壳层、跨页存活的全屏导览层（见 `../_components/GuideTourLayer`），
 * 由 `data-tour` 锚点在页面成功态后自行命中，无需页面参与。本页只负责给「时间线」
 * 与「未安排」两个区块打上锚点（在 `TodayPanel` 内）。
 */
export default function TodayPage() {
  return (
    <>
      <PageHeading>今日</PageHeading>
      <TodayPanel />
    </>
  );
}
