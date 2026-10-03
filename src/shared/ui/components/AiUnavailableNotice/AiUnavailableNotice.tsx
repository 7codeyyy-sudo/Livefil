'use client';

import { Button } from '../Button/Button';

import styles from './AiUnavailableNotice.module.css';

export type AiUnavailableNoticeProps = {
  /** 「重试」的回调（重新发一次生成请求）。 */
  readonly onRetry: () => void;
  /**
   * 额外的次操作（如 C2 的「手动安排」）。
   *
   * §5 E 只固定了错误行 + 「重试」；C2 另要求「+ 次操作『手动安排』→ 既有排程创建
   * 路径」。这里留一个槽位，不把"手动安排"写进共享组件（那是排程页的语义）。
   */
  readonly secondaryAction?: { readonly label: string; readonly onClick: () => void } | undefined;
};

/**
 * AI 入口的失败回退行（《UI 页面规范》v0.22 §5 E 第 3 条；§4.6 错误行）。
 *
 * ## 冻结文案
 *
 * 「AI 暂不可用，已为你保留手动流程。」+「重试」。开关开但 provider 故障 / 超时 /
 * 超限时（`ApiRequestError` = 504 / 502 / 429）在各入口就地出现；**手动路径始终
 * 可用**，不自动切换、不弹窗。
 *
 * ## 近黑 + role="alert"
 *
 * §4.6 错误行用近黑（`--color-text-primary`）而非红色——这是一次"能力暂时不可用"
 * 的说明，不是数据错误；`role="alert"` 保证读屏会播报它（§7）。
 */
export function AiUnavailableNotice({ onRetry, secondaryAction }: AiUnavailableNoticeProps) {
  return (
    <div className={styles.notice} role="alert" data-variant="ai-unavailable">
      <p className={styles.message}>AI 暂不可用，已为你保留手动流程。</p>
      <div className={styles.actions}>
        <Button variant="ghost" onClick={onRetry}>
          重试
        </Button>
        {secondaryAction === undefined ? null : (
          <Button variant="secondary" onClick={secondaryAction.onClick}>
            {secondaryAction.label}
          </Button>
        )}
      </div>
    </div>
  );
}
