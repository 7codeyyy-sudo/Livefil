'use client';

import { useId } from 'react';
import type { ReactNode } from 'react';

import { Badge, Button } from '@/shared/ui/components';

import styles from './SettingsSection.module.css';

export type SettingsSectionProps = {
  readonly title: string;
  readonly description?: string | undefined;
  /** 本分区是否有未保存的修改。 */
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onSave: () => void;
  readonly children: ReactNode;
};

/**
 * 设置分区外壳（IAM-002，《UI 页面规范》v0.16 §5）。
 *
 * ## 每个分区独立保存
 *
 * §5 明确「每区独立标题、**独立保存**（不做整页一个巨型保存按钮）」。原因不是
 * 审美：整页保存意味着"我只想改时区"也要把提醒、AI 同意、任务默认值一起提交，
 * 任何一项校验失败都会挡住时区的保存，而用户根本看不出是哪个分区的问题。
 *
 * ## 脏标记为什么用文字 + 颜色
 *
 * §7 要求"不仅靠颜色传达信息"。徽章的 `未保存` 三个字就是那个非颜色的通路，
 * 颜色只负责让它更容易被扫到。
 */
export function SettingsSection({
  title,
  description,
  dirty,
  saving,
  error,
  onSave,
  children,
}: SettingsSectionProps) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {dirty ? <Badge variant="warning">未保存</Badge> : null}
      </header>

      {description === undefined ? null : (
        <p className={styles.description} id={descriptionId}>
          {description}
        </p>
      )}

      <div className={styles.body}>{children}</div>

      <footer className={styles.footer}>
        {/* 错误用 `role="alert"`：保存是用户主动发起的动作，失败必须被立刻播报，
            而不是等他下次扫到。 */}
        {error === null ? null : (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {/* 没改动时禁用保存：一个点了什么都不会发生的按钮，比一个灰掉的按钮
            更容易让人怀疑"是不是没生效"。 */}
        <Button variant="primary" loading={saving} disabled={!dirty} onClick={onSave}>
          保存
        </Button>
      </footer>
    </section>
  );
}
