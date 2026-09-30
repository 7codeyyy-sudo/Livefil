'use client';

import { useId } from 'react';
import type { ReactNode, SelectHTMLAttributes } from 'react';

import { FieldHint, FieldHintText, useFieldHint } from '../FieldHint/FieldHint';
import type { FieldHintKey } from '../FieldHint/FieldHint';

import styles from './Select.module.css';

export type SelectProps = {
  /** 字段标签——**必填**（§7：表单字段必须有 label）。 */
  readonly label: string;
  /** 错误信息。给出时字段标记为无效，并以 `role="alert"` 播报。 */
  readonly error?: string | undefined;
  /** 辅助说明，常驻显示在标签下方。 */
  readonly hint?: string | undefined;
  /**
   * 字段解释（§5 B「表单字段解释」，AI-002）：给出时标签尾部出现 `?` 按钮，
   * 点击在字段下方就地展开一行说明。取值来自共享层的冻结文案表 `FIELD_HINTS`。
   */
  readonly fieldHint?: FieldHintKey | undefined;
  /** `<option>` 列表。 */
  readonly children: ReactNode;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'id' | 'children'>;

/**
 * 原生 `select`（§7「使用语义化 HTML 和原生 button、input、select」）。
 *
 * 刻意不做 `appearance: none` 自定义外观：那会同时丢掉原生的键盘行为、
 * 移动端滚轮选择器和系统级的可访问性支持，为的只是一致性更好的箭头。
 * 这笔交换不划算，样式只统一尺寸、边框与排版。
 */
export function Select({ label, error, hint, fieldHint, children, ...rest }: SelectProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  // 无条件调用：字段解释的状态在「标签尾部按钮」与「字段下方说明行」之间共享。
  const fieldHintState = useFieldHint();

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

      <select
        {...rest}
        id={id}
        className={styles.select}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
      >
        {children}
      </select>

      {fieldHint === undefined ? null : <FieldHintText hint={fieldHint} state={fieldHintState} />}

      {error === undefined ? null : (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
