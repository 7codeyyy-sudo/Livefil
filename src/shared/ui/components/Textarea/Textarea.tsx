'use client';

import { useId } from 'react';
import type { TextareaHTMLAttributes } from 'react';

import styles from './Textarea.module.css';

export type TextareaProps = {
  /** 字段标签——**必填**（§7：表单字段必须有 label）。 */
  readonly label: string;
  /** 错误信息。给出时字段标记为无效，并以 `role="alert"` 播报。 */
  readonly error?: string | undefined;
  /** 辅助说明，常驻显示在标签下方。 */
  readonly hint?: string | undefined;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className' | 'id'>;

export function Textarea({ label, error, hint, rows = 3, ...rest }: TextareaProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

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

      <textarea
        {...rest}
        id={id}
        rows={rows}
        className={styles.textarea}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
      />

      {error === undefined ? null : (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
