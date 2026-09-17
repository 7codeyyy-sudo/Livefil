'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

import type { ButtonVariant } from '../Button/Button';

import styles from './IconButton.module.css';

export type IconButtonProps = {
  /**
   * 无障碍名称——**必填**。
   *
   * 图标按钮没有可见文字，缺了这个属性读屏用户只会听到「按钮」，
   * 完全不知道它要做什么。设成必填是唯一能保证它不被漏掉的做法
   * （可选属性在 16 个组件里必然会有人忘）。
   */
  readonly label: string;
  readonly variant?: ButtonVariant | undefined;
  readonly loading?: boolean | undefined;
  readonly children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children' | 'aria-label'>;

const VARIANT_CLASS_NAME: Readonly<Record<ButtonVariant, string | undefined>> = {
  primary: styles.primary,
  secondary: styles.secondary,
  ghost: styles.ghost,
  danger: styles.danger,
};

export function IconButton({
  label,
  variant = 'ghost',
  loading = false,
  disabled,
  type = 'button',
  children,
  ...rest
}: IconButtonProps) {
  const className = [styles.iconButton, VARIANT_CLASS_NAME[variant]].filter(Boolean).join(' ');

  return (
    <button
      {...rest}
      type={type}
      className={className}
      aria-label={label}
      disabled={disabled === true || loading}
      aria-busy={loading}
      data-loading={loading}
    >
      {children}
    </button>
  );
}
