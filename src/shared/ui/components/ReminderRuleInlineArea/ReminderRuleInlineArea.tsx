'use client';

import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';

import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';
import { BellIcon } from '../NotificationBell/NotificationBell';
import { ReminderRuleSection } from '../ReminderRuleSection/ReminderRuleSection';
import type { ReminderRuleSectionProps } from '../ReminderRuleSection/ReminderRuleSection';

import styles from './ReminderRuleInlineArea.module.css';

/** 触发件的定位选择器（展开态收起后，靠它把焦点还给那枚铃铛）。 */
const TRIGGER_SELECTOR = 'button[data-variant="reminder-row-trigger"]';

/**
 * 宿主行上挂着的行级快捷键。
 *
 * `TodayPanel` 的时间块行在 `<li>` 上挂了 Enter（打开编辑弹窗）/ ArrowLeft·Right
 * （改时长）/ Escape（还原）。提醒入口是**行内**的第二组交互，在铃铛或展开区里按
 * 这些键若放任冒泡，用户会「点开提醒」的同时顺手打开编辑弹窗——两组不相关的动作
 * 被一次按键同时触发。
 */
const HOST_ROW_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  ' ',
  'Escape',
  'ArrowLeft',
  'ArrowRight',
]);

export type ReminderRuleInlineAreaProps = {
  /** 触发件的无障碍名称（如「为该任务添加提醒」）。 */
  readonly label: string;
  /** 展开区 DOM id，同步到 `aria-controls`。 */
  readonly controlsId: string;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  /** 原样透传给 `ReminderRuleSection`。 */
  readonly section: ReminderRuleSectionProps;
};

/**
 * 对象内「提醒」行内展开区（《UI 页面规范》v0.23 §5 A）。
 *
 * ## 它是纯展示件，展开态由宿主受控
 *
 * 「同屏至多展开一行」是一条**跨行**约束（展开新行要先折叠旧行），只有持有整个列表
 * 的宿主知道「当前展开的是哪一行」。所以本件不做全局单例，`expanded` 与
 * `onToggleExpanded` 都由宿主给。
 *
 * ## 为什么任务行共用一件
 *
 * §5 A 要求「任务行两个渲染点（`/inbox` 任务行、已排任务行）统一为任务行共用触发件」，
 * `BellIcon` 与 `ReminderRuleSection` 均为既有件，本件只做组合，零新增 affordance。
 *
 * ## 键盘冒泡必须挡住
 *
 * 见 `HOST_ROW_KEYS`。在根节点（包裹触发件与展开区的 `<span>`）上统一拦截，
 * 触发件与展开区共同受益。
 */
export function ReminderRuleInlineArea({
  label,
  controlsId,
  expanded,
  onToggleExpanded,
  section,
}: ReminderRuleInlineAreaProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const expansionRef = useRef<HTMLDivElement>(null);
  /** 上一帧的展开态：用来区分「本行自己收起」与「初始就是收起」。 */
  const wasExpanded = useRef(false);

  useEffect(() => {
    if (expanded) {
      // §5 A：展开后焦点移至创建行首个输入（提醒时间）。
      expansionRef.current?.querySelector<HTMLInputElement>('input[type="time"]')?.focus();
    } else if (wasExpanded.current) {
      // §5 A：收起后焦点归还触发铃铛。但只有焦点**还在本行**时才归还——
      // 「同屏至多展开一行」会让旧行被动折叠，那一刻焦点已经移到用户刚点开的新行，
      // 无条件归还等于把焦点从用户手里抢回来。
      const root = rootRef.current;
      if (root !== null && root.contains(document.activeElement)) {
        root.querySelector<HTMLButtonElement>(TRIGGER_SELECTOR)?.focus();
      }
    }
    // 这里只做 `focus()`，不在 effect 里写状态（React 19 的 set-state-in-effect 会报错）。
    wasExpanded.current = expanded;
  }, [expanded]);

  return (
    <span ref={rootRef} className={styles.root} onKeyDown={blockHostRowKeys}>
      <IconButton
        label={label}
        aria-expanded={expanded}
        aria-controls={controlsId}
        onClick={onToggleExpanded}
        data-variant="reminder-row-trigger"
      >
        <BellIcon />
      </IconButton>

      {expanded ? (
        <div id={controlsId} ref={expansionRef} className={styles.expansion}>
          <ReminderRuleSection {...section} />

          <div className={styles.collapseRow}>
            {/* §5 A：「再次触发铃铛或行内『收起』（低强调）折叠」。 */}
            <Button variant="ghost" onClick={onToggleExpanded}>
              收起
            </Button>
          </div>
        </div>
      ) : null}
    </span>
  );
}

/** 挡住会冒泡到宿主行、触发宿主行级快捷键的按键（只挡冒泡，不改按键默认行为）。 */
function blockHostRowKeys(event: KeyboardEvent<HTMLElement>): void {
  if (HOST_ROW_KEYS.has(event.key)) {
    // 不 `preventDefault`：时间输入框内按方向键、空格等仍按浏览器默认处理。
    event.stopPropagation();
  }
}
