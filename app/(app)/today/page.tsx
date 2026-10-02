import type { Metadata } from 'next';

import { GuideBarContainer } from '../_components/GuideBarContainer';
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
 * 新手引导条（AI-001，UI v0.22 §5 A）挂在**页顶、面板之前**：它的出现条件是
 * 「进入今日页且四步未走完」，与面板的加载/错误态无关；放进 `TodayPanel` 的话，
 * 面板的早返回（加载中、取数失败）会把引导条一起吃掉。
 */
export default function TodayPage() {
  return (
    <>
      <PageHeading>今日</PageHeading>
      <GuideBarContainer />
      <TodayPanel />
    </>
  );
}
