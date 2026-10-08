/**
 * 背景档位的最小外部存储（UI-009）。
 *
 * ## 为什么是"外部存储"而不是 `useState`
 *
 * 档位存在 `localStorage` 里，而 `localStorage` **只在浏览器里有**：若用
 * `useState` 的惰性初值直接读，服务端渲染拿到的是"没有偏好"、客户端首次渲染
 * 拿到的是真实档位，两边树形不同就是水合不匹配（背景层在服务端与客户端会画出
 * 不同几何，React 会报警并且丢弃服务端 HTML）。用 `useState` + `useEffect` 里
 * `setState` 读又会在 effect 里同步触发级联渲染（本项目 lint 明确禁止）。
 *
 * `useSyncExternalStore` 正是为这一场景准备的：服务端快照恒为 `null`（见
 * `getAppearanceServerSnapshot`），客户端在挂载后自行取真实快照并在**水合之后**
 * 重渲染，两边都不撒谎。
 *
 * ## 存储形态
 *
 * 内存里留一份快照（同一标签页内的唯一真相），落盘交给 `appearance-storage.ts`；
 * 快照为 `null` 表示"还没从本地读过"。快照值就是档位字符串本身（原始类型），
 * 天然满足 `useSyncExternalStore` 的 `Object.is` 判等。
 */

import { readBackgroundChoice, writeBackgroundChoice } from './appearance-storage';
import type { BackgroundChoice } from '@/shared/ui/layout/BackgroundField/BackgroundField.types';

/** 内存快照：`null` = 尚未从本地读取。 */
let snapshot: BackgroundChoice | null = null;

const listeners = new Set<() => void>();

/** 订阅（`useSyncExternalStore` 的 subscribe 参数）。 */
export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 客户端快照。
 *
 * 首次调用时从 `localStorage` 读一次，之后一律返回同一个原始值字符串——
 * `useSyncExternalStore` 用 `Object.is` 判断是否变化，返回稳定值才不会陷入
 * 无限重渲染。
 *
 * 刻意**不监听 `storage` 事件**：偏好以本标签页内存里的快照为准，跨标签页的差异
 * 会在下一次整页加载时自然收敛（背景档位不是需要实时一致的协作数据）。
 */
export function getAppearanceSnapshot(): BackgroundChoice | null {
  return loadSnapshot();
}

/** 服务端快照：恒为 `null`（服务端没有 `localStorage`，见文件说明）。 */
export function getAppearanceServerSnapshot(): BackgroundChoice | null {
  return null;
}

/** 选一档并落盘。同档重复设置时直接返回，不通知订阅者（避免无谓重渲染）。 */
export function setAppearanceChoice(next: BackgroundChoice): void {
  const current = loadSnapshot();
  if (next === current) {
    return;
  }

  snapshot = next;
  writeBackgroundChoice(next);
  for (const listener of listeners) {
    listener();
  }
}

/** 取内存快照；为 `null` 时先读一次本地（读失败由 `readBackgroundChoice` 兜成默认档）。 */
function loadSnapshot(): BackgroundChoice {
  snapshot ??= readBackgroundChoice();
  return snapshot;
}
