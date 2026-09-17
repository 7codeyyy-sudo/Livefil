'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

import styles from './Button.module.css';

/**
 * 按钮的强调级（《UI 页面规范》§4.1）。
 *
 * `primary` 是近黑实心——save/开始/确认这类高强调动作；`danger` 用于删除类动作，
 * 且按 §4.1 必须配二次确认（二次确认本身属 ConfirmDialog，本组件只负责外观）。
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export type ButtonProps = {
  /**
   * 强调级，默认 `secondary`。
   *
   * 刻意不默认 `primary`：§4.1 要求「每组操作最多一个高强调主按钮」，
   * 默认成主按钮会让页面在无人决策的情况下堆出多个，把强调交给调用方显式选择。
   */
  readonly variant?: ButtonVariant | undefined;
  /**
   * 进行中：自动禁用并标记 `aria-busy`。
   *
   * 同时禁用是必要的——否则用户在等待期间可以重复点击，这正是「重复提交」的入口。
   */
  readonly loading?: boolean | undefined;
  readonly children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>;

/** 强调级到 CSS Modules 类的映射。用表而非条件链：新增一级只需加一行。 */
const VARIANT_CLASS_NAME: Readonly<Record<ButtonVariant, string | undefined>> = {
  primary: styles.primary,
  secondary: styles.secondary,
  ghost: styles.ghost,
  danger: styles.danger,
};

export function Button({
  variant = 'secondary',
  loading = false,
  disabled,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const className = [styles.button, VARIANT_CLASS_NAME[variant]].filter(Boolean).join(' ');

  return (
    <button
      {...rest}
      // 默认 `button` 而不是 HTML 的 `submit`：表单里的按钮绝大多数不是提交，
      // 默认 submit 会让「点了一下取消」顺带提交整个表单。
      type={type}
      className={className}
      disabled={disabled === true || loading}
      aria-busy={loading}
      data-loading={loading}
    >
      {children}
    </button>
  );
}
