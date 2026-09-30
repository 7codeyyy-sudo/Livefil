'use client';

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { clampGuideStep, TOTAL_GUIDE_STEPS } from '../_lib/guide/guide-steps';
import {
  getGuideServerSnapshot,
  getGuideSnapshot,
  subscribeGuide,
  updateGuideState,
} from '../_lib/guide/guide-store';
import { INITIAL_GUIDE_STATE } from '../_lib/guide/guide-storage';
import type { GuideState } from '../_lib/guide/guide-storage';

/** 引导状态的读写口（`GuideBarContainer` 与 `HelpDrawerContainer` 共用一份）。 */
export type GuideContextValue = {
  /**
   * 进度；`null` 表示**还没从本地读出来**（服务端渲染与客户端水合首帧都是它，
   * 见 `guide-store.ts` 的说明：那是唯一不会造成水合不匹配的取值）。
   */
  readonly state: GuideState | null;
  /** 引导条此刻是否该出现（`GuideBarContainer` 与 Provider 共用同一条判据）。 */
  readonly visible: boolean;
  /** 「跳过」与「×」：停止自动出现，进度保留。 */
  readonly dismiss: () => void;
  /** 帮助抽屉里的「重新查看新手引导」。 */
  readonly reopen: () => void;
  /** 一轮核对的结果写回（只前进不回退，见函数说明）。 */
  readonly advance: (step: number) => void;
};

const GuideContext = createContext<GuideContextValue | null>(null);

/**
 * 新手引导的状态宿主（《UI 页面规范》v0.22 §5 A，AI-001）。
 *
 * ## 为什么它挂在外壳层而不是今日页
 *
 * 帮助抽屉（§5 B）里的「重新查看新手引导」要能改这份状态，而抽屉挂在**顶栏**上
 * ——顶栏在每一次导航里都还在，今日页会卸载。状态必须活在两者的共同祖先上，
 * 否则"在别的页面重新查看引导"会点了个寂寞。
 *
 * ## 它不取数、不核对
 *
 * 判定要发请求，而判定只在**今日页**进行（§5 A：进入 `/today` 时页顶出现引导条）。
 * 外壳是全站挂载的，如果它去核对，用户每到一个页面都会打一轮接口。所以核对落
 * 在 `GuideBarContainer`（今日页专属），本组件只持状态与三个动作。
 *
 * ## 状态为什么走 `useSyncExternalStore`
 *
 * 见 `guide-store.ts`：进度在 `localStorage` 里，而它只在浏览器存在；用 `useState`
 * 读会造成水合不匹配，用 effect 里 `setState` 读会级联渲染（lint 禁止）。
 */
export function GuideProvider({ children }: { readonly children: ReactNode }) {
  const state = useSyncExternalStore(subscribeGuide, getGuideSnapshot, getGuideServerSnapshot);

  const dismiss = useCallback(() => {
    updateGuideState((current) => ({ ...current, dismissed: true }));
  }, []);

  const reopen = useCallback(() => {
    // 走完四步后再「重新查看」＝重看一遍，从第一步起；没走完的续接既有进度
    // （"进度保留"约束的是「跳过」与「×」，见 `GuideState.dismissed`）。
    updateGuideState((current) =>
      current.completed
        ? { ...INITIAL_GUIDE_STATE, dismissed: false }
        : { ...current, dismissed: false },
    );
  }, []);

  const advance = useCallback((step: number) => {
    updateGuideState((current) => {
      const reached = clampGuideStep(step);
      // 已完成步不回退：本轮的结果没超过既有进度时按原引用返回（不重渲染、不写盘）。
      if (reached <= current.step) {
        return current;
      }

      // 四步全通过即自动标记完成并隐藏：`dismissed` 一并置真，使"完成"与"用户关掉"
      // 在可见性判据上走同一条路（见 `visible`）。
      return reached >= TOTAL_GUIDE_STEPS
        ? { completed: true, dismissed: true, step: TOTAL_GUIDE_STEPS }
        : { ...current, step: reached };
    });
  }, []);

  const visible = state !== null && !state.completed && !state.dismissed;

  const value = useMemo<GuideContextValue>(
    () => ({ state, visible, dismiss, reopen, advance }),
    [state, visible, dismiss, reopen, advance],
  );

  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
}

/** 读引导状态；不在 `GuideProvider` 内使用时显式报错（而不是拿到一个空壳）。 */
export function useGuideContext(): GuideContextValue {
  const value = useContext(GuideContext);
  if (value === null) {
    throw new Error('useGuideContext 必须在 GuideProvider 内使用');
  }
  return value;
}
