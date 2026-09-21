'use client';

import styles from './Checkbox.module.css';

export type CheckboxProps = {
  /**
   * 无障碍名称（`aria-label`）。
   *
   * 多选框在列表行里**没有可见文字标签**（行内容就是它的语义对象），名称
   * 由调用方给全（如「选择任务：买菜」）——读屏用户听到的不该只是"复选框"。
   */
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (nextChecked: boolean) => void;
  /**
   * 半选态（§4.8）：表头全选框在"部分行被选中"时的形态。
   * 原生 `input.indeterminate` 只能经 ref 设置，React 不透传这个属性。
   */
  readonly indeterminate?: boolean | undefined;
  readonly disabled?: boolean | undefined;
};

/**
 * 复选框（UI-005，《UI 页面规范》v0.19 §4.8）。
 *
 * ## 为什么是原生 `input[type=checkbox]`（§4.8 冻结）
 *
 * 多选表达"先选择、后批量提交"，提交前不生效——这与 `Switch`（开/关立即
 * 生效）是两种交互合同，形态冻结时就明确了分工：**批量选择走 Checkbox，
 * 即时开关走 Switch，两者不可互相冒充**。原生 input 自带键盘（空格切换）、
 * 读屏（checked/indeterminate 状态播报）与表单语义，无需手写。
 *
 * 视觉上"跟随 Input"：同样的边框、圆角与表面色，选中态用主按钮的近黑
 * （与 Switch 一致——强调色蓝只用于状态、进度与焦点）。对勾与半选横线用
 * 内联 SVG，颜色引用令牌，**没有新增任何令牌**。
 */
export function Checkbox({ label, checked, onChange, indeterminate, disabled }: CheckboxProps) {
  return (
    <label className={styles.root}>
      <input
        type="checkbox"
        className={styles.input}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        // `indeterminate` 不受控于 checked：它是"部分选中"的展示态，
        // 只能经 DOM 属性设置（HTML 规范如此，React 特意不代理它）。
        ref={(element) => {
          if (element !== null) {
            element.indeterminate = indeterminate === true;
          }
        }}
      />
      {/* 勾选图形是纯装饰：状态已由 input 的 checked/indeterminate 播报。 */}
      <span className={styles.box} aria-hidden="true">
        <svg className={styles.mark} viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path className={styles.check} d="M2 6.5 5 9.5 10 3" />
          <path className={styles.dash} d="M2.5 6H9.5" />
        </svg>
      </span>
    </label>
  );
}
