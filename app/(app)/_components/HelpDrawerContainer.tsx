'use client';

import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { HelpDrawer, IconButton } from '@/shared/ui/components';

import { TOTAL_GUIDE_STEPS } from '../_lib/guide/guide-steps';
import { helpNextStepText } from '../_lib/help-content';

import { useGuideContext } from './GuideProvider';

/**
 * 「帮助与引导」容器（《UI 页面规范》v0.22 §5 B，AI-002）。
 *
 * ## 一个容器带出两件东西
 *
 * 顶栏的问号入口（`aria-label="帮助与引导"`）与它打开的抽屉同出一个容器，跟
 * `NotificationsContainer` 同一条做法：抽屉经 `OverlayPortal` 挂到 `body`，
 * 所以它虽然写在顶栏的槽里，也不会真的挤在页头。
 *
 * ## 与 `ai_enabled` 无关
 *
 * §5 B 与 §5 E 第 2 条都要求引导与帮助**不随 `ai_enabled` 开关消失**，所以这里
 * 没有任何读该开关的分支，抽屉里也没有任何 AI 能力——它就是一份静态说明。
 *
 * ## 为什么进度取不到时按第 1 步显示
 *
 * `state` 为 `null` 只是"本地还没读出来"（首帧），此时显示「第 1 / 4 步」是最
 * 中性的回显：它不谎称完成，也不需要额外的加载态。读取在挂载后立刻完成。
 */
export function HelpDrawerContainer() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { state, reopen } = useGuideContext();

  const stepIndex = Math.min(state?.step ?? 0, TOTAL_GUIDE_STEPS - 1);

  return (
    <>
      <IconButton
        label="帮助与引导"
        aria-haspopup="dialog"
        data-variant="help-entry"
        onClick={() => {
          setOpen(true);
        }}
      >
        ？
      </IconButton>

      <HelpDrawer
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        nextStepText={helpNextStepText(pathname)}
        guideProgress={{
          stepNumber: stepIndex + 1,
          totalSteps: TOTAL_GUIDE_STEPS,
          completed: state?.completed ?? false,
        }}
        onReopenGuide={() => {
          // 先关抽屉再看引导条：引导条在今日页页顶，抽屉盖着它时点了也看不见。
          reopen();
          setOpen(false);
        }}
      />
    </>
  );
}
