'use client';

import { useId } from 'react';

import { Button } from '../Button/Button';
import { OverlayShell } from '../_internal/overlay';

import styles from './ConfirmDialog.module.css';

/**
 * 「取消」按钮的标记（浮层内部约定）。
 *
 * 选择器与属性名写成两个常量、**此处必须保持一致**：焦点陷阱按选择器找它，
 * 按钮靠属性标记自己。之所以不合成一个值——JSX 的属性名必须是字面量，
 * 无法由变量拼出；用展开对象能满足类型检查，但再用它反推选择器字符串时
 * （`Object.keys(...)[0]`）在 `noUncheckedIndexedAccess` 下会退化成
 * `string | undefined`，拼进选择器就是 `[undefined]`，那种错误只在运行期才炸。
 *
 * 为什么不直接给 `Button` 传 ref：`Button` 是批次 1 的产物、没有 `ref` 透传，
 * 而为了一个用法去改一个已合并的公共组件，改动面大于收益。
 */
const CANCEL_SELECTOR = '[data-confirm-cancel]';
const CANCEL_ATTRIBUTE = { 'data-confirm-cancel': 'true' } as const;

export type ConfirmDialogProps = {
  readonly open: boolean;
  /** 取消：关闭且不执行操作。ESC 与点遮罩走同一条路（§4.5：「语义等同取消」）。 */
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly title: string;
  /** 说明正文：讲清「会发生什么」。经 `aria-describedby` 与对话框关联。 */
  readonly description: string;
  readonly confirmLabel?: string | undefined;
  readonly cancelLabel?: string | undefined;
  /** 危险操作（删除、账户删除等）：确认按钮走 danger 强调级，且初始焦点落在「取消」。 */
  readonly destructive?: boolean | undefined;
  /** 操作进行中：两个按钮都禁用，避免重复提交。 */
  readonly pending?: boolean | undefined;
};

/**
 * 确认弹窗（《UI 页面规范》§4.5，v0.8 冻结形态）。
 *
 * ## 它与 Modal 的关系
 *
 * 属于「Modal 的特化」，但**共享的是机制而不是 Modal 组件本身**：
 * 两者都走 `OverlayShell`（挂到 body、遮罩、滚动锁、ESC、焦点陷阱、退场延迟卸载），
 * 各自表达界面。让 ConfirmDialog 去调 Modal 再靠 props 把自己的差异塞进去，
 * 会把 Modal 撑成一个参数越来越杂的万能组件——而这里真正的差异（没有关闭图标、
 * 有描述正文、语义是 `alertdialog`）本来就是**界面**差异，不是**机制**差异。
 *
 * ## 两处安全默认（§4.5 明文）
 *
 * 1. **危险操作的初始焦点落在「取消」**——用户打开弹窗后随手按回车或空格时，
 *    焦点若在确认按钮上就等于一键删除。
 * 2. **ESC 与点遮罩等同取消**，而不是"什么都不做"——关闭意图明确时，
 *    用户的预期是这个操作没有发生。
 */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  destructive = false,
  pending = false,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <OverlayShell
      open={open}
      onClose={onCancel}
      // `alertdialog` 而非 `dialog`：确认操作要求用户立刻注意到，
      // 读屏软件对 alertdialog 的播报更主动。
      role="alertdialog"
      labelledBy={titleId}
      describedBy={descriptionId}
      initialFocusSelector={destructive ? CANCEL_SELECTOR : undefined}
      panelClassName={styles.panel}
    >
      <h2 id={titleId} className={styles.title}>
        {title}
      </h2>

      <p id={descriptionId} className={styles.description}>
        {description}
      </p>

      <div className={styles.actions}>
        {/* 取消在前、确认在后：LTR 阅读顺序下「危险的那一个」在最后，
            与 §4.1「每组操作最多一个高强调主按钮」也一致。 */}
        <Button {...CANCEL_ATTRIBUTE} onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} loading={pending}>
          {confirmLabel}
        </Button>
      </div>
    </OverlayShell>
  );
}
