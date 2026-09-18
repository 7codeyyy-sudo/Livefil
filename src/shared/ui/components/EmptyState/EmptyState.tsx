import type { ReactNode } from 'react';

import styles from './EmptyState.module.css';

export type EmptyStateProps = {
  /** 标题：一句话说明「这里现在是什么状态」。 */
  readonly title: string;
  /**
   * 描述：说明**下一步做什么**。
   *
   * §1.1 要求「空状态提供具体下一步，不使用泛化的"开启你的 AI 之旅"」——
   * 泛化文案是 AI 味最明显的特征之一，这条要求落在文案上，组件只能给它一个
   * 必填的位置：不填就没法用。
   */
  readonly description: string;
  /**
   * 主操作槽（如「新建任务」）。
   *
   * 传**真实的 `Button`**，不接收 `{ label, onClick }` 配置对象——与 Modal 的
   * `footer`、Drawer 的 `footer` 同一约定。配置对象会把调用方的 `variant`、
   * `loading`、埋点属性全部吃掉，而这三样恰恰是按钮最常被定制的地方。
   */
  readonly action?: ReactNode | undefined;
  /** 次要操作槽（如「了解做法」）。强调级由调用方决定。 */
  readonly secondaryAction?: ReactNode | undefined;
};

/**
 * 空状态（《UI 页面规范》v0.11 §4.6，UI-002 批次 4）。
 *
 * ## 外观严格复刻原型 `.empty-state`
 *
 * 虚线框 + 圆角 + 表面底 + 居中。**刻意不加图标**：原型没有这个形态，
 * 而「无消费者不预造」是本项目一贯的口径（同批次 2 的 Badge 拒绝 accent 变体）。
 *
 * ## 标题为什么用 `<p>` 而不是 `<h3>`
 *
 * 组件不知道自己被嵌在多深的标题层级里：页面只有 `<h1>` 时给出 `<h3>` 会跳级，
 * 破坏读屏用户的文档大纲。这里用普通段落 + 字重/颜色分层表达视觉层级，
 * 语义层级交给调用方的页面结构决定。
 *
 * ## 为什么不带 `'use client'`
 *
 * 它没有任何交互，可以在服务端渲染的页面里直接用；需要交互的按钮由调用方
 * 作为 `action` 传进来（那些按钮自己会带上客户端边界）。
 */
export function EmptyState({ title, description, action, secondaryAction }: EmptyStateProps) {
  const hasActions = action !== undefined || secondaryAction !== undefined;

  return (
    <div className={styles.root}>
      <p className={styles.title}>{title}</p>
      <p className={styles.description}>{description}</p>
      {hasActions ? (
        <div className={styles.actions}>
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
