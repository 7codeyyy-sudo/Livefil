'use client';

import { useSyncExternalStore } from 'react';

/**
 * 「首次调用前一次性数据发送确认」的会话内状态（《UI 页面规范》§5 C4）。
 *
 * ## 为什么用 `sessionStorage` 而不是组件内 `state`
 *
 * §5 C4 要求「同意后**本会话**不再弹」。四个 AI 入口分散在 `/inbox`、`/week`、
 * `/expenses`、`/review` 四个页面，组件内 `state` 只在单个容器存活期内有效——
 * 用户同意后在页面间跳转会**再弹一次**，与"本会话不再弹"不符。`sessionStorage`
 * 以标签页会话为界，正好表达"本会话"（关闭标签页即重置），也与设置页分区 5 的
 * **持久**同意（`ai_data_consent`，落服务端）分层：分区 5 是总开关与持久同意，
 * 这里只是"每次可见的范围告知"的首次确认，两层不重复弹（§5 C4 末段）。
 *
 * ## 为什么走 `useSyncExternalStore`
 *
 * `sessionStorage` 只在浏览器里存在：用 `useState` 惰性初值直接读会造成服务端 /
 * 客户端首帧不一致（水合不匹配），用 effect 里 `setState` 又会级联渲染（lint 禁）。
 * 与 `guide-store.ts` 同一做法：服务端快照恒为 `null`，客户端挂载后自行取真实
 * 快照并在水合之后重渲染。
 */

/** 会话同意的存储键（带版本号，便于将来改判口径时自然作废旧值）。 */
export const AI_CONSENT_STORAGE_KEY = 'livefil.ai-consent.v1';

/** 内存快照：`null` = 尚未从本地读取（服务端与客户端首帧都是它）。 */
let snapshot: boolean | null = null;

const listeners = new Set<() => void>();

/** 订阅（`useSyncExternalStore` 的 subscribe 参数）。 */
function subscribeAiConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 读会话同意；读不出来（隐私模式 / 被禁用）一律按"未同意"处理。 */
function readAiConsent(): boolean {
  try {
    return window.sessionStorage.getItem(AI_CONSENT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 客户端快照：首次读取后缓存，返回稳定的基本类型值。 */
function getAiConsentSnapshot(): boolean | null {
  snapshot ??= readAiConsent();
  return snapshot;
}

/** 服务端快照：恒为 `null`（服务端没有 `sessionStorage`）。 */
function getAiConsentServerSnapshot(): boolean | null {
  return null;
}

/** 记录"本会话已同意发送数据给 AI"。 */
export function grantAiConsent(): void {
  if (snapshot === true) {
    return;
  }
  snapshot = true;
  try {
    window.sessionStorage.setItem(AI_CONSENT_STORAGE_KEY, '1');
  } catch {
    // 存不下只意味着"下次还要再确认一次"，不中断当前交互。
  }
  for (const listener of listeners) {
    listener();
  }
}

/** 读会话同意；`null` 表示还没读出来（此时按"需要确认"处理，入口不渲染）。 */
export function useAiConsent(): boolean | null {
  return useSyncExternalStore(subscribeAiConsent, getAiConsentSnapshot, getAiConsentServerSnapshot);
}
