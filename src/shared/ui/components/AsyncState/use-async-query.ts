'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 异步取数的三态（《UI 页面规范》v0.14 §4.7）。
 *
 * **三态而非四态**：`empty` 不是取数层的概念，而是「成功但数据为空」这一
 * 业务判断。它由 `<AsyncState>` 用调用方给的 `isEmpty` 判据从 `success` 里
 * 分流出去——取数原语不该知道「空」对一个任务列表意味着什么。
 */
export type AsyncQueryState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: Error }
  | { readonly status: 'success'; readonly data: T };

/** 已经落定的结果（与它对应的请求标识）。 */
type Settled<T> = {
  readonly requestId: string;
  readonly result: Exclude<AsyncQueryState<T>, { readonly status: 'loading' }>;
};

export type UseAsyncQueryOptions<T> = {
  /**
   * 请求标识。变化即重新取数。
   *
   * 让调用方显式给出而不是由 hook 从 `queryFn` 推导：内联箭头函数每次渲染
   * 都是新引用，用函数身份做依赖会变成「每渲染一次就发一次请求」。
   */
  readonly queryKey: readonly string[];
  /** 取数函数。`signal` 必须转交给 `fetch`，否则中止不会真正生效。 */
  readonly queryFn: (signal: AbortSignal) => Promise<T>;
};

export type UseAsyncQueryResult<T> = {
  readonly state: AsyncQueryState<T>;
  /** 手动重新取数（错误态的重试按钮接它）。 */
  readonly refetch: () => void;
};

/**
 * 取数原语（《UI 页面规范》v0.14 §4.7，UI-004）。
 *
 * ## 为什么不是 SWR / React Query
 *
 * 本批要的只有「四态 + 手动重试」。引入一个带缓存、去重、后台刷新、乐观更新
 * 的库，等于顺带接受一整套缓存语义决策（什么时候该失效、并发同 key 怎么办），
 * 而这些问题在还没有真实数据源时全部无法验证。§4.7 因此明确：不缓存、
 * 不后台刷新、不去重、不乐观更新，`queryKey` 本批只用于「将来扩展」与
 * 「测试可辨」。真实缓存需求随 Phase 3 的数据场景再议。
 *
 * ## 为什么没有指数退避重试
 *
 * 《详细设计说明书》§6.2 对**外部服务调用**要求「指数退避 + jitter，最多 2–3 次」，
 * 但那条规则的前提是「重试只用于幂等读取或明确可重试的外部调用」。§4.7 对本
 * 原语的要求更严：**不自动重试**——页面加载失败时静默重发三次，用户看到的是
 * 更长的白屏和更难解释的延迟；而「重试」本身是用户可理解的动作，交给他按。
 */
export function useAsyncQuery<T>({
  queryKey,
  queryFn,
}: UseAsyncQueryOptions<T>): UseAsyncQueryResult<T> {
  const key = JSON.stringify(queryKey);
  /** 手动重试的计数器：它进 `requestId`，因此重试会把状态推回 loading。 */
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);

  // `queryFn` 刻意不进 effect 依赖（见 `queryKey` 的说明），但必须保证
  // 请求发出时用的是**最新**那个闭包——否则它读到的 props 会是旧的。
  const queryFnRef = useRef(queryFn);
  useEffect(() => {
    queryFnRef.current = queryFn;
  }, [queryFn]);

  const requestId = `${key}#${String(attempt)}`;

  useEffect(() => {
    const controller = new AbortController();

    queryFnRef
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) {
          return;
        }
        setSettled({ requestId, result: { status: 'success', data } });
      })
      .catch((cause: unknown) => {
        // **abort 不是失败**：它是「这次请求作废」，卸载与 key 变化都会走到
        // 这里。若把它记成错误态，用户会看到一次莫名其妙的「加载失败」。
        if (controller.signal.aborted) {
          return;
        }
        setSettled({ requestId, result: { status: 'error', error: toError(cause) } });
      });

    return () => {
      controller.abort();
    };
  }, [requestId]);

  // 「正在加载」是**派生**出来的：只要手头的结果不属于当前请求，就还没有结果。
  // 这样 key 变化与手动重试都不需要在 effect 里同步 setState（那会多一次级联渲染），
  // 也就不会在渲染阶段和请求阶段之间露出一帧陈旧数据。
  const state: AsyncQueryState<T> =
    settled !== null && settled.requestId === requestId ? settled.result : { status: 'loading' };

  const refetch = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return { state, refetch };
}

/**
 * 把任意抛出物归一成 `Error`。
 *
 * 调用方（`app/(app)/_lib` 里的取数函数）会把 HTTP 非 2xx 也转成 `Error`，
 * 但 JS 允许 `throw` 任何值，而 `AsyncState` 要读 `error.message`——
 * 这里兜住那一步，接口层就不必重复做类型断言。
 */
function toError(cause: unknown): Error {
  if (cause instanceof Error) {
    return cause;
  }
  if (typeof cause === 'string') {
    return new Error(cause);
  }
  return new Error('request failed');
}
