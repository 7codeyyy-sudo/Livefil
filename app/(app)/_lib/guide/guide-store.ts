/**
 * 引导进度的最小外部存储（《UI 页面规范》v0.22 §5 A，AI-001）。
 *
 * ## 为什么是"外部存储"而不是 `useState`
 *
 * 进度存在 `localStorage` 里，而 `localStorage` **只在浏览器里有**：若用
 * `useState` 的惰性初值直接读，服务端渲染拿到的是"没有进度"、客户端首次渲染
 * 拿到的是真实进度，两边树形不同就是水合不匹配（React 会报警并且丢弃服务端
 * HTML）。用 `useState` + `useEffect` 里 `setState` 读又会在 effect 里同步触发
 * 级联渲染（本项目 lint 明确禁止）。
 *
 * `useSyncExternalStore` 正是为这一场景准备的：服务端快照恒为 `null`（见
 * `getGuideServerSnapshot`），客户端在挂载后自行取真实快照并在**水合之后**重渲染，
 * 两边都不撒谎。
 *
 * ## 存储形态
 *
 * 内存里留一份快照（同一标签页内的唯一真相），落盘交给 `guide-storage.ts`；
 * 快照为 `null` 表示"还没从本地读过"。
 */

import { readGuideState, writeGuideState } from './guide-storage';
import type { GuideState } from './guide-storage';

/** 内存快照：`null` = 尚未从本地读取。 */
let snapshot: GuideState | null = null;

const listeners = new Set<() => void>();

/** 订阅（`useSyncExternalStore` 的 subscribe 参数）。 */
export function subscribeGuide(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 客户端快照。
 *
 * 首次调用时从 `localStorage` 读一次，之后一律返回同一个引用——`useSyncExternalStore`
 * 用 `Object.is` 判断是否变化，每次返回新对象会让它陷入无限重渲染。
 *
 * 刻意**不监听 `storage` 事件**：进度以本标签页内存里的快照为准，跨标签页的差异
 * 会在下一次整页加载时自然收敛（引导进度不是需要实时一致的协作数据）。
 */
export function getGuideSnapshot(): GuideState | null {
  return loadSnapshot();
}

/** 服务端快照：恒为 `null`（服务端没有 `localStorage`，见文件说明）。 */
export function getGuideServerSnapshot(): GuideState | null {
  return null;
}

/**
 * 按当前快照算下一个快照并落盘。
 *
 * `compute` 返回**同一个引用**表示"没有变化"：此时不通知订阅者（避免无谓重渲染），
 * 也不写盘。
 */
export function updateGuideState(compute: (current: GuideState) => GuideState): void {
  const current = loadSnapshot();

  const next = compute(current);
  if (next === current) {
    return;
  }

  snapshot = next;
  writeGuideState(next);
  for (const listener of listeners) {
    listener();
  }
}

/** 取内存快照；为 `null` 时先读一次本地（读失败由 `readGuideState` 兜成初始值）。 */
function loadSnapshot(): GuideState {
  snapshot ??= readGuideState();
  return snapshot;
}
