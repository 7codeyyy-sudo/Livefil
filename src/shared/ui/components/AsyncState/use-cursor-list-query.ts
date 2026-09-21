'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * 游标分页列表的取数状态（UI-005，《UI 页面规范》v0.18 §5「加载更多」）。
 *
 * ## 为什么不是 `useAsyncQuery`
 *
 * 收件箱的「加载更多」是**累积**语义：新页追加到已渲染的列表后面，而不是
 * 替换它。`useAsyncQuery` 的 `refetch` 是整体替换——用它做分页，每次
 * loadMore 都会把用户已经看到的行换成一份新数组，滚动位置与选中状态都保不住。
 * 累积语义因此单开一个原语，而不是给旧 hook 加一个含义含混的模式参数。
 *
 * ## 失败的分层
 *
 * 首页失败 → 整页错误态（重试重置一切）；**加载更多失败 ≠ 列表失败**：
 * 已经在手里的行仍然有效，只把错误挂到 `loadMoreError` 上，用户重试的是
 * "继续加载"这一步。替换语义会把这两层失败混成一团。
 */
export type CursorListState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: Error }
  | {
      readonly status: 'success';
      readonly items: readonly T[];
      readonly hasMore: boolean;
      /** 下一页请求是否在途（「加载更多」按钮的 loading 态）。 */
      readonly isLoadingMore: boolean;
      /** 上一次「加载更多」的失败；重试或翻新列表时清除。 */
      readonly loadMoreError: Error | null;
    };

export type UseCursorListQueryOptions<T> = {
  /**
   * 请求标识。变化即**重置**列表并重新取首页（与 `useAsyncQuery` 同一口径：
   * key 显式给出，不从内联函数推导）。
   */
  readonly queryKey: readonly string[];
  /**
   * 取一页数据。`cursor` 为 `null` 表示首页；返回 `hasMore` 与 `nextCursor`
   * 供原语判断是否还有下一页——服务端的游标不透明，客户端只原样回传。
   */
  readonly queryFn: (
    signal: AbortSignal,
    cursor: string | null,
  ) => Promise<{
    readonly items: readonly T[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  }>;
};

export type UseCursorListQueryResult<T> = {
  readonly state: CursorListState<T>;
  /** 追加下一页（首页成功且 `hasMore` 时才有意义）。 */
  readonly loadMore: () => void;
  /** 重置回首页重新取数（错误态重试、写操作成功后的刷新都接它）。 */
  readonly refetch: () => void;
};

export function useCursorListQuery<T>({
  queryKey,
  queryFn,
}: UseCursorListQueryOptions<T>): UseCursorListQueryResult<T> {
  const key = JSON.stringify(queryKey);
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{
    readonly requestId: string;
    readonly result:
      | {
          readonly status: 'success';
          readonly data: {
            readonly items: readonly T[];
            readonly nextCursor: string | null;
            readonly hasMore: boolean;
          };
        }
      | { readonly status: 'error'; readonly error: Error };
  } | null>(null);
  const [isLoadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);

  // 单一在途请求的控制器：key 变化、refetch、loadMore 都先取消上一个——
  // 分页场景里"旧页比新页后到"会把列表写坏，这里用覆盖式 abort 收口。
  const controllerRef = useRef<AbortController | null>(null);
  const queryFnRef = useRef(queryFn);
  useEffect(() => {
    queryFnRef.current = queryFn;
  }, [queryFn]);

  const requestId = `${key}#${String(attempt)}`;

  useEffect(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    queryFnRef
      .current(controller.signal, null)
      .then((data) => {
        if (controller.signal.aborted) {
          return;
        }
        setSettled({ requestId, result: { status: 'success', data } });
        setLoadMoreError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setSettled({ requestId, result: { status: 'error', error: toError(cause) } });
      });

    return () => {
      controller.abort();
    };
  }, [requestId]);

  const base: CursorListState<T> =
    settled !== null && settled.requestId === requestId
      ? settled.result.status === 'success'
        ? {
            status: 'success',
            items: settled.result.data.items,
            hasMore: settled.result.data.hasMore,
            isLoadingMore,
            loadMoreError,
          }
        : { status: 'error', error: settled.result.error }
      : { status: 'loading' };

  // loadMore 不用 useCallback 空依赖记忆：它需要读到**当前**的 settled 状态
  // （游标与 hasMore），事件处理器随渲染重建是这里想要的语义。
  const loadMore = () => {
    if (
      settled === null ||
      settled.requestId !== requestId ||
      settled.result.status !== 'success'
    ) {
      return;
    }
    if (isLoadingMore || !settled.result.data.hasMore || settled.result.data.nextCursor === null) {
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLoadingMore(true);
    setLoadMoreError(null);

    queryFnRef
      .current(controller.signal, settled.result.data.nextCursor)
      .then((data) => {
        if (controller.signal.aborted) {
          return;
        }
        setSettled((previous) => {
          if (
            previous === null ||
            previous.requestId !== requestId ||
            previous.result.status !== 'success'
          ) {
            return previous;
          }
          return {
            requestId,
            result: {
              status: 'success',
              data: {
                items: [...previous.result.data.items, ...data.items],
                nextCursor: data.nextCursor,
                hasMore: data.hasMore,
              },
            },
          };
        });
        setLoadingMore(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        // 只标记"继续加载"这一步失败：已在手里的行不动。
        setLoadMoreError(toError(cause));
        setLoadingMore(false);
      });
  };

  const refetch = () => {
    setLoadMoreError(null);
    setAttempt((current) => current + 1);
  };

  return { state: base, loadMore, refetch };
}

function toError(cause: unknown): Error {
  if (cause instanceof Error) {
    return cause;
  }
  if (typeof cause === 'string') {
    return new Error(cause);
  }
  return new Error('request failed');
}
