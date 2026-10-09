'use client';

import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { HelpDrawer, IconButton } from '@/shared/ui/components';

import { TOUR_PAGE_KEYS, tourPageKeyForPath } from '../_lib/guide/tour-steps';
import type { TourState } from '../_lib/guide/tour-storage';
import { helpNextStepText } from '../_lib/help-content';

import { useGuideTourContext } from './GuideTourProvider';

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
 * ## 入口即 v0.25 导览第 3 步的锚点
 *
 * § B 表把顶栏这个问号入口冻结为 `/today` 第 3 步的锚点 `help-entry`（既有
 * `aria-label` 可就近复用），故此处补一枚 `data-tour`（新增标记属性，不改语义与样式）。
 *
 * ## 「重新查看新手引导」重开**当前所在页**
 *
 * § C：帮助 Drawer 内的入口从当前所在页重新开启本页导览、不清除其他页的记录。
 * 页面归属由 `usePathname()` 判定；非六页（无导览）时该动作无落点，直接关闭抽屉。
 *
 * ## 进度回显
 *
 * 显示「已看过 n / 6 个页签」；全局「跳过引导」后六页均视作已看过。
 */
export function HelpDrawerContainer() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { state, reopen } = useGuideTourContext();
  const page = tourPageKeyForPath(pathname);

  const seenPages =
    state === null ? 0 : state.skipped ? TOUR_PAGE_KEYS.length : countSeen(state.seen);

  return (
    <>
      <IconButton
        label="帮助与引导"
        aria-haspopup="dialog"
        data-tour="help-entry"
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
        tourProgress={{ seenPages, totalPages: TOUR_PAGE_KEYS.length }}
        onReopenGuide={() => {
          if (page !== null) {
            reopen(page);
          }
          // 先关抽屉再看导览：导览层是全屏浮层，抽屉盖着它时点了也看不见。
          setOpen(false);
        }}
      />
    </>
  );
}

/** 已看过的页签数（`skipped` 的「全看过」由调用方另行处理）。 */
function countSeen(seen: TourState['seen']): number {
  return TOUR_PAGE_KEYS.filter((key) => seen[key] === true).length;
}
