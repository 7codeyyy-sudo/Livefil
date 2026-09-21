'use client';

import styles from './Switch.module.css';

export type SwitchProps = {
  /**
   * 开关的可见标签。
   *
   * 它**同时是无障碍名称**：控件就是一个 `<button>`，标签是它的内容，所以
   * 读屏会念出「开启提醒，开关，已开启」。不需要额外的 `<label for>`——那个
   * 属性只对可标记表单元素（input/select/textarea）有效，用在 button 上会
   * 静默失效，而这正是"看起来有标签、实际没有"的典型来源。
   */
  readonly label: string;
  readonly checked: boolean;
  /** 切换回调。**给的是目标值**，不是「切一下」——调用方不必自己取反。 */
  readonly onChange: (nextChecked: boolean) => void;
  readonly disabled?: boolean | undefined;
  /** 供调用方附加描述用的 id（`aria-describedby` 一般由容器给）。 */
  readonly describedBy?: string | undefined;
};

/**
 * 开关（IAM-002，《UI 页面规范》v0.16 §5）。
 *
 * ## 为什么是 `button[role=switch]` 而不是 checkbox
 *
 * §5 明确要求「AI 开关（role=switch）」。两者的语义差别不是外观：`checkbox`
 * 表达"选中/未选中"，提交时才生效；`switch` 表达"开/关"，**立即生效**。
 * 用 checkbox 冒充会让读屏用户以为还要按一次提交。
 *
 * 用原生 `<button>` 承载 `role="switch"`（而不是 `<div role="switch">`）：
 * 键盘可聚焦、空格/回车触发、禁用态、表单语义全部由浏览器提供，不需要
 * 手写 `tabIndex` 与 `onKeyDown`——那些手写实现最容易漏掉"回车"或"重复触发"。
 *
 * ## 关于 §4 没有开关形态章节
 *
 * 规范 §4 目前没有开关小节，视觉取值因此全部落在既有令牌上（关闭时是
 * `--color-border` 轨道 + `--color-surface` 滑块，开启时是 `--color-primary-surface`
 * 轨道 + `--color-on-primary` 滑块），**没有新增任何令牌**。形态待规范收编。
 */
export function Switch({ label, checked, onChange, disabled, describedBy }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      aria-describedby={describedBy}
      className={styles.root}
      onClick={() => {
        onChange(!checked);
      }}
    >
      {/* 轨道与滑块是纯装饰：状态已经由 `aria-checked` 表达，
          读屏不该把它们再念一遍。 */}
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      <span className={styles.label}>{label}</span>
    </button>
  );
}
