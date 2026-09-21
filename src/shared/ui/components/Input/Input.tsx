'use client';

import { useId } from 'react';
import type { InputHTMLAttributes, Ref } from 'react';

import styles from './Input.module.css';

export type InputProps = {
  /** 字段标签——**必填**（§7：表单字段必须有 label）。 */
  readonly label: string;
  /** 错误信息。给出时字段标记为无效，并以 `role="alert"` 播报。 */
  readonly error?: string | undefined;
  /** 辅助说明，常驻显示在标签下方。 */
  readonly hint?: string | undefined;
  /**
   * 聚焦内层 `input`（UI-005：顶栏「＋快速添加」落页后聚焦输入框）。
   * React 19 里 `ref` 是普通 prop，但类型上不会随 `Omit` 带过来，这里显式声明。
   */
  readonly ref?: Ref<HTMLInputElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id' | 'ref'>;

export function Input({ label, error, hint, ref, ...rest }: InputProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // 只登记**实际渲染出来**的说明元素：aria-describedby 指向不存在的 id
  // 会让读屏软件读到空内容，比不指更糟。
  const describedBy = [
    hint === undefined ? undefined : hintId,
    error === undefined ? undefined : errorId,
  ]
    .filter((value) => value !== undefined)
    .join(' ');

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>

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

      {/* 错误不仅靠颜色传达（§2.1）：这里有实际文本，并且用 role="alert" 播报。 */}
      {error === undefined ? null : (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
