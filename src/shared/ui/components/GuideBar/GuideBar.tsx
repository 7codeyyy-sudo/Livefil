'use client';

import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';

import styles from './GuideBar.module.css';

/** 进度文案（§5 A 冻结形如「第 n / 4 步」；帮助 Drawer 的进度回显共用这一处）。 */
export function formatGuideProgress(stepNumber: number, totalSteps: number): string {
  return `第 ${String(stepNumber)} / ${String(totalSteps)} 步`;
}

export type GuideBarProps = {
  /** 当前步序号（从 1 起算），用于「第 n / 4 步」与步进条高亮。 */
  readonly stepNumber: number;
  readonly totalSteps: number;
  /** 当前步卡文（冻结文本，由 `GUIDE_STEPS` 给）。 */
  readonly cardText: string;
  /** 当前步主操作文案（冻结文本，如「去创建」）。 */
  readonly actionLabel: string;
  /** 主操作：指向该步的真实落点（由容器负责导航）。 */
  readonly onAction: () => void;
  readonly onSkip: () => void;
  readonly onClose: () => void;
};

/**
 * 新手引导条（《UI 页面规范》v0.22 §5 A，AI-001）。
 *
 * ## 它是引导条，不是全屏弹层
 *
 * §5 A 入口时机明文「页顶出现**引导条**（非全屏弹层——页面保持可操作，§1 克制）」，
 * 所以这里既不遮罩也不锁滚动：它只是页面顶部的一块，用户在引导条存在时照样能
 * 操作整页。关闭与跳过的语义（停止自动出现、进度保留）由容器落状态，本组件
 * 只负责发出请求。
 *
 * ## 为什么是纯展示件
 *
 * 与 `AsyncState` / `ReminderRuleSection` 同一条边界：组件不取数、不读
 * `localStorage`、不导航，判定与进度全在 `app/(app)` 层的容器里。这样它能在
 * jsdom 里被纯 props 驱动地测完，共享层也不必知道引导规则的存在。
 *
 * ## 步进条不是循环动画
 *
 * §6 首次加载纪律禁止无意义的循环动画，这里也没有任何过渡声明——「reduced-motion
 * 下步进过渡归零」由「本就没有过渡」直接满足，组件内不写 `prefers-reduced-motion`。
 */
export function GuideBar({
  stepNumber,
  totalSteps,
  cardText,
  actionLabel,
  onAction,
  onSkip,
  onClose,
}: GuideBarProps) {
  return (
    <section className={styles.bar} aria-label="新手引导" data-variant="guide-bar">
      <div className={styles.head}>
        {/* 步进条的图形是装饰：进度由右侧那句「第 n / 4 步」如实播报，
            再让读屏逐点数一遍只会变成噪音。 */}
        <span className={styles.progress}>
          <span className={styles.steps} aria-hidden="true">
            {Array.from({ length: totalSteps }, (_, index) => (
              <span
                key={index}
                className={styles.dot}
                data-current={index === stepNumber - 1}
                data-done={index < stepNumber - 1}
              />
            ))}
          </span>
          <span className={styles.progressText}>{formatGuideProgress(stepNumber, totalSteps)}</span>
        </span>

        <span className={styles.closeSlot}>
          <IconButton label="关闭新手引导" onClick={onClose}>
            ×
          </IconButton>
        </span>
      </div>

      <p className={styles.card}>{cardText}</p>

      <div className={styles.actions}>
        <Button variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
        {/* 跳过是低强调：它与主操作并列出现，但不该抢主操作的位置。 */}
        <Button variant="ghost" onClick={onSkip}>
          跳过
        </Button>
      </div>
    </section>
  );
}
