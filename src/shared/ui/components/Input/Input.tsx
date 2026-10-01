'use client';

import { useId } from 'react';
import type { InputHTMLAttributes, Ref } from 'react';

import { FieldHint, FieldHintText, useFieldHint } from '../FieldHint/FieldHint';
import type { FieldHintKey } from '../FieldHint/FieldHint';

import styles from './Input.module.css';

export type InputProps = {
  /** 字段标签——**必填**（§7：表单字段必须有 label）。 */
  readonly label: string;
  /** 错误信息。给出时字段标记为无效，并以 `role="alert"` 播报。 */
  readonly error?: string | undefined;
  /** 辅助说明，常驻显示在标签下方。 */
  readonly hint?: string | undefined;
  /**
   * 字段解释（§5 B「表单字段解释」，AI-002）：给出时标签尾部出现 `?` 按钮，
   * 点击在字段下方就地展开一行说明。取值来自共享层的冻结文案表 `FIELD_HINTS`，
   * 控件自己不知道文案内容。
   */
  readonly fieldHint?: FieldHintKey | undefined;
  /**
   * 聚焦内层 `input`（UI-005：顶栏「＋快速添加」落页后聚焦输入框）。
   * React 19 里 `ref` 是普通 prop，但类型上不会随 `Omit` 带过来，这里显式声明。
   */
  readonly ref?: Ref<HTMLInputElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id' | 'ref'>;

export function Input({ label, error, hint, fieldHint, ref, ...rest }: InputProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  // 无条件调用：字段解释的状态要在「标签尾部的按钮」与「字段下方的说明行」之间共享。
  const fieldHintState = useFieldHint();

  // 只登记**实际渲染出来**的说明元素：aria-describedby 指向不存在的 id
  // 会让读屏软件读到空内容，比不指更糟。字段解释行收起时不渲染，因此也只在
  // 展开时登记。
  const describedBy = [
    hint === undefined ? undefined : hintId,
    fieldHint !== undefined && fieldHintState.open ? fieldHintState.textId : undefined,
    error === undefined ? undefined : errorId,
  ]
    .filter((value) => value !== undefined)
    .join(' ');

  return (
    <div className={styles.field}>
      <span className={styles.labelRow}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        {fieldHint === undefined ? null : <FieldHint label={label} state={fieldHintState} />}
      </span>

      {hint === undefined ? null : (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      )}

      <input
        {...rest}
        ref={ref}
        id={id}
        className={styles.input}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
      />

      {fieldHint === undefined ? null : <FieldHintText hint={fieldHint} state={fieldHintState} />}

      {/* 错误不仅靠颜色传达（§2.1）：这里有实际文本，并且用 role="alert" 播报。 */}
      {error === undefined ? null : (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
