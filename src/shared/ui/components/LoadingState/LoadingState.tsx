import type { ReactNode } from 'react';

import styles from './LoadingState.module.css';

export type LoadingStateProps = {
  /**
   * 视觉隐藏的加载说明（读屏专用）。默认「正在加载…」。
   *
   * 屏幕上刻意**没有任何可见的加载文字或转圈**——骨架本身就是可见信号。
   * 但读屏用户看不到骨架，所以必须有一句能被朗读的说明，否则整个加载期间
   * 他们听到的是一片空白。
   */
  readonly label?: string | undefined;
  /** 骨架内容：用同模块导出的 `Skeleton` 组合出与真实内容同形的轮廓。 */
  readonly children?: ReactNode | undefined;
};

/**
 * 页面/区块首次加载状态（《UI 页面规范》v0.11 §4.6，UI-002 批次 4）。
 *
 * ## 为什么是静态骨架，而不是 spinner 或闪烁
 *
 * §6「首次加载不使用无意义的循环动画」是硬条款：一个转圈或呼吸动画在
 * 内容到达前后没有任何信息量，只是让页面「看起来在忙」。骨架相反——
 * **它的形状就是信息**：用户能提前知道这里将出现一个标题和两行文字，
 * 内容落位时不会有布局跳动。
 *
 * 所以这里连 shimmer（掠光）都不做：那是把「无信息量的动」换了个更花的形式。
 *
 * ## 分工边界（§4.6 明确）
 *
 * 本组件只负责**页面/区块首次加载**。保存、同步、AI 处理这类**进行态**
 * 不归它：控件级的归 `Button` 的 `loading`，有确定百分比的归 `Progress`，
 * 瞬时结果反馈归 `Toast`。混用会让「页面还没内容」和「某个操作在做」
 * 看起来一模一样。
 *
 * ## 与 `Progress` 的关系
 *
 * `Progress` 的 `value` 是必填的确定值（缺了就抛错），本来就表达不了
 * 不确定的首次加载——这也是本组件存在的直接原因，而不是给它加一个
 * indeterminate 模式去覆盖两种语义。
 */
export function LoadingState({ label = '正在加载…', children }: LoadingStateProps) {
  return (
    // `role="status"` 自带 `aria-live="polite"`；`aria-busy` 告诉读屏
    // 这个区域正在更新，等结果出来再朗读，避免读到半截内容。
    <div className={styles.root} role="status" aria-busy="true">
      <span className={styles.visuallyHidden}>{label}</span>
      {children}
    </div>
  );
}
