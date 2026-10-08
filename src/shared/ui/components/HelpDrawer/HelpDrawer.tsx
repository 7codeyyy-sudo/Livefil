'use client';

import { Button } from '../Button/Button';
import { Drawer } from '../Drawer/Drawer';

import styles from './HelpDrawer.module.css';

/** 导览进度的回显形状（由容器从 `GuideTourProvider` 映射）。 */
export type HelpDrawerTourProgress = {
  /** 已看过的页签数。 */
  readonly seenPages: number;
  /** 页签总数（六页）。 */
  readonly totalPages: number;
};

export type HelpDrawerProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 首块「当前页下一步」的文案（按路由静态映射，冻结文本由 app 层给）。 */
  readonly nextStepText: string;
  readonly tourProgress: HelpDrawerTourProgress;
  /** 次块按钮「重新查看新手引导」（A 节的重新打开入口，重开当前所在页）。 */
  readonly onReopenGuide: () => void;
};

/**
 * 「帮助与引导」抽屉（《UI 页面规范》v0.22 §5 B，AI-002）。
 *
 * ## 为什么是纯展示件
 *
 * 路由映射在 `app/(app)/_lib/help-content.ts`、导览进度在 `GuideTourProvider`——
 * 两者都不该让共享层知道（前者要知道路由表、后者要读 `localStorage`）。组件只
 * 拿两个字符串 + 一个回调。
 *
 * ## 为什么不放任何 AI 能力
 *
 * §5 B 明文「帮助 Drawer **不放任何 AI 能力**（AI-002 非 AI，AI 关闭时照常可用）」，
 * 且 §5 E 第 2 条要求引导与帮助**不随 `ai_enabled` 开关消失**。所以这里既没有
 * 任何 AI 入口，也没有任何读 `aiEnabled` 的分支——外壳照常渲染它。
 */
export function HelpDrawer({
  open,
  onClose,
  nextStepText,
  tourProgress,
  onReopenGuide,
}: HelpDrawerProps) {
  return (
    <Drawer open={open} onClose={onClose} title="帮助与引导">
      <section className={styles.section} aria-label="当前页下一步">
        <h3 className={styles.heading}>当前页下一步</h3>
        <p className={styles.text}>{nextStepText}</p>
      </section>

      <section className={styles.section} aria-label="新手引导">
        <h3 className={styles.heading}>新手引导</h3>
        <p className={styles.text}>
          {tourProgress.seenPages >= tourProgress.totalPages
            ? `${String(tourProgress.totalPages)} 个页签的引导都看过了。`
            : `已看过 ${String(tourProgress.seenPages)} / ${String(tourProgress.totalPages)} 个页签。`}
        </p>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onReopenGuide}>
            重新查看新手引导
          </Button>
        </div>
      </section>
    </Drawer>
  );
}
