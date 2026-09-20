'use client';

import type { ReactNode } from 'react';

import { Button } from '../Button/Button';
import { EmptyState } from '../EmptyState/EmptyState';
import type { EmptyStateProps } from '../EmptyState/EmptyState';
import { ErrorState } from '../ErrorState/ErrorState';
import { LoadingState } from '../LoadingState/LoadingState';

import type { AsyncQueryState } from './use-async-query';

export type AsyncStateProps<T> = {
  /** 取数状态，由 `useAsyncQuery` 产出。 */
  readonly state: AsyncQueryState<T>;
  /**
   * 空判据：成功但「没有内容」时走空态。
   *
   * 由调用方给而不是容器猜：同一个 `[]` 对不同页面意味着不同的下一步
   * （收件箱空了要引导记一笔，目标空了要引导立一个方向）。
   */
  readonly isEmpty: (data: T) => boolean;
  /** 成功且非空时渲染真实内容。 */
  readonly renderSuccess: (data: T) => ReactNode;
  /** 空态配置，原样透传给 `EmptyState`（标题、描述与操作槽）。 */
  readonly empty: EmptyStateProps;
  /**
   * 错误态标题。**必填**——§4.7 要求容器不内置任何泛化文案，
   * 而 `ErrorState` 的标题本身是必填的，两处约束合起来只能是「调用方给」。
   */
  readonly errorTitle: string;
  /**
   * 错误态描述。不给则用 `error.message`（那是具体失败信息，不是泛化文案）。
   *
   * 建议页面都显式给一句：`message` 来自取数层，措辞未经过产品视角的打磨，
   * 而且可能夹带技术细节。
   */
  readonly errorDescription?: string | undefined;
  /** 加载态的页面骨架轮廓（用 `Skeleton` 组合）。不给则只有读屏说明。 */
  readonly loading?: ReactNode | undefined;
  /**
   * 重试回调，接 `useAsyncQuery` 的 `refetch`。
   *
   * 为什么它不在 `state` 里：`state` 是**数据**（可序列化、可单测构造），
   * 而重试是**能力**。把回调塞进联合类型会让每个构造 state 的地方
   * （测试、将来的缓存层）都被迫提供一个它并不拥有的函数。
   */
  readonly onRetry: () => void;
};

/**
 * 四态容器（《UI 页面规范》v0.14 §4.7，UI-004）。
 *
 * ## 它只做一件事：把状态翻译成组件
 *
 * 容器**绝不发请求**（不 import `fetch`、不持有 stream），请求由
 * `useAsyncQuery` 负责、由页面组装后把 `state` 传进来。这条边界让容器
 * 可以在 jsdom 里被纯数据驱动地测完四种状态——不需要网络、不需要 mock、
 * 不需要等待。
 *
 * ## 为什么不内置文案
 *
 * §4.7：不许出现写死的「出错了」「暂无数据」。看上去是省事，实际是把
 * 「这一步该做什么」这个唯一有价值的判断从页面手里拿走了——而只有页面
 * 知道它的空态下一步是「去收件箱挑一个」还是「先立一个目标」。
 *
 * ## 与三个状态组件的关系
 *
 * 它们是**纯展示**（§4.6），本容器是它们与取数之间的唯一接缝。所以这里
 * 没有任何自己的视觉：四种状态全部落在既有组件上，零新增令牌。
 */
export function AsyncState<T>({
  state,
  isEmpty,
  renderSuccess,
  empty,
  errorTitle,
  errorDescription,
  loading,
  onRetry,
}: AsyncStateProps<T>) {
  if (state.status === 'loading') {
    return <LoadingState>{loading}</LoadingState>;
  }

  if (state.status === 'error') {
    return (
      <ErrorState
        title={errorTitle}
        description={errorDescription ?? state.error.message}
        // 近黑 primary：重试是**肯定动作**。danger 只留给删除那类不可逆确认
        // （§4.6），把它用在这里会稀释那个语义。
        action={
          <Button variant="primary" onClick={onRetry}>
            重试
          </Button>
        }
      />
    );
  }

  if (isEmpty(state.data)) {
    return <EmptyState {...empty} />;
  }

  return <>{renderSuccess(state.data)}</>;
}
