'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';

import {
  getTourServerSnapshot,
  getTourSnapshot,
  subscribeTour,
  updateTourState,
} from '../_lib/guide/tour-store';
import type { TourPageKey } from '../_lib/guide/tour-steps';
import type { TourState } from '../_lib/guide/tour-storage';

/**
 * 一次「重新查看」请求。
 *
 * `token` 自增，使**同一页的连续两次重开**也各自成为一次新的请求（否则两次请求
 * 值相等，消费者侧的 effect 不会重跑）。`page` 是请求发起时所在的页——导览层据此
 * 只认「当前所在页」的请求（§ C：帮助 Drawer 重开**当前所在页**的导览）。
 */
export type TourReopenRequest = {
  readonly page: TourPageKey;
  readonly token: number;
};

/** 导览状态的读写口（`GuideTourLayer` 与 `HelpDrawerContainer` 共用一份）。 */
export type GuideTourContextValue = {
  /**
   * 进度；`null` 表示**还没从本地读出来**（服务端渲染与客户端水合首帧都是它，
   * 那是唯一不会造成水合不匹配的取值）。
   */
  readonly state: TourState | null;
  /** 记某一页「已看过」（本页导览走完时由导览层调用）。 */
  readonly markSeen: (page: TourPageKey) => void;
  /** 「跳过引导」/ `Esc`：一次性终止整个导览，六页均视作已看过（§ C）。 */
  readonly skipAll: () => void;
  /** 帮助抽屉里的「重新查看新手引导」：重开**当前所在页**的导览。 */
  readonly reopen: (page: TourPageKey) => void;
  /** 最近一次重开请求（导览层订阅它来重新开启）。 */
  readonly reopenRequest: TourReopenRequest | null;
};

const GuideTourContext = createContext<GuideTourContextValue | null>(null);

/**
 * 新手导览的状态宿主
 * （《UI 页面规范》v0.25「新手引导形态升版补节」，AI-007）。
 *
 * ## 为什么它挂在外壳层
 *
 * 与旧 `GuideProvider` 同一装配层级（§ A：挂 `(app)` 外壳层、跨页存活）。帮助
 * 抽屉（v0.22 §5 B）里的「重新查看新手引导」要能重开当前页导览，而抽屉挂在顶栏
 * 上——顶栏每次导航都还在，页面会卸载；共享状态只能活在共同祖先里。
 *
 * ## 它不取数、不核对
 *
 * 判定（锚点是否存在）落在 `GuideTourLayer`，本组件只持状态与三个动作。
 *
 * ## 状态为什么走 `useSyncExternalStore`
 *
 * 见 `tour-store.ts`：进度在 `localStorage` 里，而它只在浏览器存在。
 */
export function GuideTourProvider({ children }: { readonly children: ReactNode }) {
  const state = useSyncExternalStore(subscribeTour, getTourSnapshot, getTourServerSnapshot);

  const [reopenRequest, setReopenRequest] = useState<TourReopenRequest | null>(null);
  // 请求序号：不进 state（它只是给 effect 用的「变了」信号），用 ref 自增即可。
  const reopenTokenRef = useRef(0);

  const markSeen = useCallback((page: TourPageKey) => {
    updateTourState((current) =>
      // 已记录即返回同一引用：不重渲染、不写盘。
      current.seen[page] === true
        ? current
        : { ...current, seen: { ...current.seen, [page]: true } },
    );
  }, []);

  const skipAll = useCallback(() => {
    updateTourState((current) => (current.skipped ? current : { ...current, skipped: true }));
  }, []);

  const reopen = useCallback((page: TourPageKey) => {
    reopenTokenRef.current += 1;
    setReopenRequest({ page, token: reopenTokenRef.current });
  }, []);

  const value = useMemo<GuideTourContextValue>(
    () => ({ state, markSeen, skipAll, reopen, reopenRequest }),
    [state, markSeen, skipAll, reopen, reopenRequest],
  );

  return <GuideTourContext.Provider value={value}>{children}</GuideTourContext.Provider>;
}

/** 读导览状态；不在 `GuideTourProvider` 内使用时显式报错（而不是拿到空壳）。 */
export function useGuideTourContext(): GuideTourContextValue {
  const value = useContext(GuideTourContext);
  if (value === null) {
    throw new Error('useGuideTourContext 必须在 GuideTourProvider 内使用');
  }
  return value;
}
