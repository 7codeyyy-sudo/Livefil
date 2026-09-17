'use client';

import { useId } from 'react';
import type { ReactNode } from 'react';

import { IconButton } from '../IconButton/IconButton';
import { OverlayShell } from '../_internal/overlay';

import styles from './Modal.module.css';

export type ModalProps = {
  readonly open: boolean;
  /** 关闭请求（ESC、点遮罩、点 X）。调用方决定是否真的关闭。 */
  readonly onClose: () => void;
  /** 面板标题，同时作为无障碍名称（`aria-labelledby`）。 */
  readonly title: string;
  readonly children: ReactNode;
  /** 底部操作区，通常是按钮组。 */
  readonly footer?: ReactNode | undefined;
  /**
   * 初始焦点的选择器（相对面板）。不给则聚焦面板本身。
   *
   * 危险操作的确认弹窗会把它指向「取消」按钮（§4.5 的防误触要求）。
   */
  readonly initialFocusSelector?: string | undefined;
  /** 是否渲染右上角关闭按钮，默认 `true`。确认弹窗会关掉它。 */
  readonly closable?: boolean | undefined;
};

/**
 * 居中模态弹窗（《UI 页面规范》§4.5，v0.8 冻结形态）。
 *
 * ## 形态取值只来自 §4.5
 *
 * 遮罩 `--color-overlay`、面板宽 `min(480px, 100%)`、`--radius-lg`、
 * 表面色底 + `--shadow-overlay`、进退场 `--duration-slow`。
 *
 * **刻意不画原型 `.modal` 的那道半透明白色磨砂边框**：
 * 它属于 §2.4「暂不收编」项（与 §1.1 反玻璃拟态条款相关），随 UI-003 外壳
 * 对磨砂效果整体决策。也不拿别的令牌顶替伪造——那是用另一个语义掩盖差异，
 * 审查时无法自证。层次由 28% 遮罩 + overlay 阴影提供，视觉上足够。
 * （此处刻意不写那道边界的颜色字面量：纪律扫描禁止它在令牌文件之外出现，
 * 注释也不行——注释里的值同样会被复制粘贴带进代码。）
 *
 * ## 为什么不自带按钮
 *
 * 规范要求「弹窗不能包含完整复杂流程」，而「弹窗里放什么按钮」是页面级决策
 * （保存 / 创建 / 确认的具体语义各不相同）。组件只提供 `footer` 槽位，
 * 按钮由调用方传入——这也让确认弹窗能复用同一套机制而不用改 Modal 的行为。
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  initialFocusSelector,
  closable = true,
}: ModalProps) {
  const titleId = useId();

  return (
    <OverlayShell
      open={open}
      onClose={onClose}
      role="dialog"
      labelledBy={titleId}
      initialFocusSelector={initialFocusSelector}
      panelClassName={styles.panel}
    >
      <div className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {closable ? (
          <IconButton label="关闭" onClick={onClose}>
            ×
          </IconButton>
        ) : null}
      </div>

      <div className={styles.body}>{children}</div>

      {footer === undefined ? null : <div className={styles.footer}>{footer}</div>}
    </OverlayShell>
  );
}
