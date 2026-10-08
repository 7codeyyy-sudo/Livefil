/**
 * 新手导览「已看过」记录的本地持久化
 * （《UI 页面规范》v0.25「新手引导形态升版补节」C，AI-007）。
 *
 * ## 为什么存本地而不是服务端
 *
 * 与 v0.22 §5 A 同一条理由（原 `guide-storage.ts`）：导览进度是**纯客户端、
 * 可丢弃**的一件小事——它只影响「这一台浏览器要不要自动显示本页导览」，与用户
 * 数据无关，换设备重看一遍不是损失。§ C 冻结的判定依据是「六页各一枚已看过
 * 记录」，存储介质与键名归实现披露（§ D 已知缺口 2）。
 *
 * ## 为什么要带版本号
 *
 * key 里的 `.v1` 与旧 `livefil.guide.v1` **不同**：v0.25 换了形态与口径
 * （四步 → 13 步、全局序号 → 本页子序号），旧值语义已不同，故另立一条 key，
 * 旧值自然被忽略，不必写迁移代码。
 *
 * ## 容错
 *
 * 读写都 try/catch 且把存下来的值当**不可信输入**解析：隐私模式、配额耗尽、
 * 被策略禁用时 `localStorage` 会抛异常，而「存不下进度」的表现应当只是「下次
 * 再看一遍导览」，绝不能让六个页面打不开。
 */

import { TOUR_PAGE_KEYS } from './tour-steps';
import type { TourPageKey } from './tour-steps';

/** 「已看过」记录的存储键（带版本号，见文件说明）。 */
export const TOUR_STORAGE_KEY = 'livefil.guide-tour.v1';

/** 导览进度。 */
export type TourState = {
  /** 六页各一枚「已看过」：键存在且为 `true` 即该页已看过。 */
  readonly seen: Readonly<Partial<Record<TourPageKey, true>>>;
  /**
   * 用户按过「跳过引导」或 `Esc`——**一次性终止整个导览**（§ C 全局口径）。
   *
   * 置真后六页均视作已看过，此后不再自动开启；`seen` 里的既有记录保留不动
   * （便于帮助抽屉如实回显「看过了几页」）。
   */
  readonly skipped: boolean;
};

/** 初始进度：一页都没看过。 */
export const INITIAL_TOUR_STATE: TourState = {
  seen: {},
  skipped: false,
};

/**
 * 读进度。
 *
 * 缺失、损坏（手工改坏 / 旧格式）或读不出来时一律返回初始值——`localStorage`
 * 里的东西是**不可信输入**，一个形状不符的值不该让导览把某一页判成「已看过」
 * 而静默不再出现。
 */
export function readTourState(): TourState {
  try {
    const raw = window.localStorage.getItem(TOUR_STORAGE_KEY);
    if (raw === null) {
      return INITIAL_TOUR_STATE;
    }
    return parseTourState(JSON.parse(raw));
  } catch {
    // JSON 坏了、或 localStorage 本身不可用（隐私模式等）：按「从没看过」处理。
    return INITIAL_TOUR_STATE;
  }
}

/** 写进度；失败只影响「下次是否还要再看一遍」。 */
export function writeTourState(state: TourState): void {
  try {
    window.localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 配额耗尽 / 存储被禁用：不中断当前交互（见文件说明）。
  }
}

/** 把一段未知值收成进度形状；逐字段校验，任一不符即退回该字段的初始值。 */
function parseTourState(value: unknown): TourState {
  if (typeof value !== 'object' || value === null) {
    return INITIAL_TOUR_STATE;
  }

  const { seen, skipped } = value as Readonly<Record<string, unknown>>;
  return {
    seen: parseSeen(seen),
    skipped: skipped === true,
  };
}

/** 只收下六个已知页签里「值为 `true`」的键，其余一律丢弃。 */
function parseSeen(value: unknown): Partial<Record<TourPageKey, true>> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }

  const source = value as Readonly<Record<string, unknown>>;
  const seen: Partial<Record<TourPageKey, true>> = {};
  for (const key of TOUR_PAGE_KEYS) {
    if (source[key] === true) {
      seen[key] = true;
    }
  }
  return seen;
}
