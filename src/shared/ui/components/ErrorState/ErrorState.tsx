import type { ReactNode } from 'react';

import styles from './ErrorState.module.css';

export type ErrorStateProps = {
  /** 标题：说明「出错了」，而不是复述技术原因。 */
  readonly title: string;
  /** 描述：说明**用户现在能做什么**，必要时给出错误编号。 */
  readonly description: string;
  /**
   * 主操作槽，**必填**。
   *
   * 与另外两个状态不同：错误态是**阻塞**的——用户面前这一块什么都没有，
   * 不给出口就只能刷新页面。所以它在类型层面就是必填，而不是靠文档提醒。
   * 通常是「重试」按钮，约定用近黑 `primary` 变体（重试是**肯定动作**，
   * `danger` 变体只留给删除那类破坏性确认）。
   */
  readonly action: ReactNode;
  /** 次要操作槽（如「返回首页」）。 */
  readonly secondaryAction?: ReactNode | undefined;
};

/**
 * 阻塞式错误状态（《UI 页面规范》v0.11 §4.6，UI-002 批次 4）。
 *
 * ## 与 Toast 的分工
 *
 * `Toast` 是**瞬时、非阻塞**的反馈：某个操作失败了，页面主体照常可用。
 * 本组件是**阻塞、占满内容区**的状态：这一块内容没能加载出来，用户必须
 * 先处理它。两者经常在同一个失败里同时出现（Toast 说「同步失败」，
 * ErrorState 占据那块没能加载的区域），但语义与寿命完全不同，不互相替代。
 *
 * ## 为什么只有图标带颜色
 *
 * 错误态面积比 Toast 大一个数量级。整片红（红底、红框、红字）在 §1「安静、
 * 克制」的基调下过于喧哗，而且会**稀释 danger 的分量**——删除确认那种真正
 * 不可逆的操作，才是 danger 该最刺眼的地方。所以这里只有图标取 `--color-danger`，
 * 标题仍是 `--color-text-primary`。
 *
 * ## 为什么没有衬底边框
 *
 * 虚线框是空态**专有**的语言（「这里还没有东西」）。错误态不是「还没有」，
 * 而是「出错了」，套用同一套外观会让两者在视觉上分不清。§4.6 明确划了这条界线。
 */
export function ErrorState({ title, description, action, secondaryAction }: ErrorStateProps) {
  return (
    // `role="alert"`：阻塞态在插入时就该被读屏立刻播报，而不是等用户
    // 自己 Tab 过来才发现。这里没有嵌套的 live region，不会重复播报。
    <div className={styles.root} role="alert">
      <ErrorIcon />
      <p className={styles.title}>{title}</p>
      <p className={styles.description}>{description}</p>
      <div className={styles.actions}>
        {action}
        {secondaryAction}
      </div>
    </div>
  );
}

/**
 * 警示图标（`currentColor` 内联 SVG，颜色由 CSS 侧给）。
 *
 * 与 Toast 的警示图标是同一枚圆环感叹号。**暂不抽成共享模块**：两处的
 * 尺寸语境不同（Toast 里跟着 13px 正文走、这里跟着 16px 正文走），
 * 共用会立刻需要给共享组件加 size 参数，而它只有两个消费者。
 * 若第三个消费者出现，再收编到 `_internal/icons`。
 */
function ErrorIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.75V8.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11.25" r="0.9" fill="currentColor" />
    </svg>
  );
}
