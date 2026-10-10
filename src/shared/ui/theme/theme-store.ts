/**
 * 主题档位的最小外部存储（UI-012，形态与 `app/(app)/_lib/appearance` 同款）。
 *
 * ## 为什么是「外部存储」而不是 `useState`
 *
 * 档位存在 `localStorage` 里，而 `localStorage` **只在浏览器里有**：若用
 * `useState` 的惰性初值直接读，服务端渲染拿到「没有偏好」、客户端首次渲染
 * 拿到真实档位，两边树形不同就是水合不匹配。`useSyncExternalStore` 正是为这
 * 一场景准备的：服务端快照恒为 `null`，客户端在挂载后自行取真实快照并在
 * **水合之后**重渲染，两边都不撒谎。
 *
 * 注意：**视觉层不依赖本 store 的挂载时机**——防闪由根布局的引导脚本在首帧前
 * 完成（见 `theme-apply.ts` 说明）；本 store 负责的是设置页单选态的读取与
 * 切换动作。
 *
 * ## 存储形态
 *
 * 内存里留一份快照（同一标签页内的唯一真相），落盘交给 `theme-storage.ts`；
 * 快照为 `null` 表示「还没从本地读过」。快照值就是档位字符串本身（原始类型），
 * 天然满足 `useSyncExternalStore` 的 `Object.is` 判等。
 */

import { applyThemeWithTransition } from './theme-apply';
import { readTheme, writeTheme } from './theme-storage';
import type { Theme } from './theme-storage';

/** 内存快照：`null` = 尚未从本地读取。 */
let snapshot: Theme | null = null;

const listeners = new Set<() => void>();

/** 订阅（`useSyncExternalStore` 的 subscribe 参数）。 */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 客户端快照。
 *
 * 首次调用时从 `localStorage` 读一次，之后返回稳定值——`useSyncExternalStore`
 * 用 `Object.is` 判断是否变化，返回稳定值才不会陷入无限重渲染。
 * 刻意**不监听 `storage` 事件**：偏好以本标签页内存快照为准（与背景档位同口径）。
 */
export function getThemeSnapshot(): Theme | null {
  return loadSnapshot();
}

/** 服务端快照：恒为 `null`（服务端没有 `localStorage`，见文件说明）。 */
export function getThemeServerSnapshot(): Theme | null {
  return null;
}

/**
 * 选一档：翻内存快照、落盘、经 View Transition 落 DOM 属性，最后通知订阅者。
 *
 * 顺序是刻意的：先定状态（快照 + 本地），再把 DOM 属性变更交给过渡的更新回调
 * （快照对里「旧」＝切换前、「新」＝切换后），最后通知 React 让设置页单选态
 * 跟上——这一步落在 `html.theming` 的过渡豁免期内，不会与快照打架。
 * 同档重复设置时直接返回，不触发过渡与重渲染。
 */
export function setTheme(next: Theme, origin: Element | null = null): void {
  if (next === loadSnapshot()) {
    return;
  }

  snapshot = next;
  writeTheme(next);
  applyThemeWithTransition(next, origin);

  for (const listener of listeners) {
    listener();
  }
}

/** 取内存快照；为 `null` 时先读一次本地（读失败由 `readTheme` 兜成默认档）。 */
function loadSnapshot(): Theme {
  snapshot ??= readTheme();
  return snapshot;
}
