import type { ReactNode } from 'react';

import styles from './Badge.module.css';

/**
 * Badge 的语义变体。
 *
 * 只有四个：`neutral` 是默认的中性标签，另三个对应 §2.1 的三个状态色。
 * `accent` 刻意不做——§2.4 只为状态色配了边框令牌，规范也没有「强调色徽章」
 * 这个需求，凭空加一个就是预造。
 */
export type BadgeVariant = 'neutral' | 'success' | 'warning' | 'danger';

export type BadgeProps = {
  readonly variant?: BadgeVariant | undefined;
  /**
   * 徽章内容。**必须是文字**（或含文字的组合）。
   *
   * §2.1 明文要求「颜色不能成为唯一语义载体」——一个只有颜色没有文字的色块
   * 对色觉障碍用户等于没有信息。这里用类型放宽（`ReactNode`）而不是收紧，
   * 是因为「有文字」无法在类型层表达；约束靠评审与本组件的使用方式保证。
   */
  readonly children: ReactNode;
};

/** 变体到 CSS Modules 类的映射。用表而非条件链：新增变体只需加一行。 */
const VARIANT_CLASS_NAME: Readonly<Record<BadgeVariant, string | undefined>> = {
  neutral: styles.neutral,
  success: styles.success,
  warning: styles.warning,
  danger: styles.danger,
};

/**
 * 状态标签（《UI 页面规范》§2.4「中性 Tag」与状态色三级层次）。
 *
 * 刻意不带 `'use client'`：它是纯展示元素，没有任何交互与状态，
 * 因此可以在服务端渲染的页面里直接使用。
 */
export function Badge({ variant = 'neutral', children }: BadgeProps) {
  const className = [styles.badge, VARIANT_CLASS_NAME[variant]].filter(Boolean).join(' ');

  // 用 `span` 而不是 `div`：徽章经常出现在段落或行内文本中间，
  // 块级元素会在那里造成不该有的换行。
  return (
    <span className={className} data-variant={variant}>
      {children}
    </span>
  );
}
