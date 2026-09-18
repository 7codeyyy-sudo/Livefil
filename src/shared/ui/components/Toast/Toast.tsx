'use client';

import { useEffect, useState } from 'react';
import type { TransitionEvent } from 'react';

import { IconButton } from '../IconButton/IconButton';

import styles from './Toast.module.css';
import type { ToastRecord, ToastVariant } from './toast-context';

/**
 * 自动关闭时长（毫秒，**组件内命名常量，刻意不做成 CSS 令牌**）。
 *
 * 为什么不做令牌：这组数字不是"动效时长"，而是**信息可读时间**——它取决于
 * 文案长度与阅读速度，与视觉节奏无关。做成 `--duration-*` 会让它和过渡时长
 * 混在一个语义里，将来有人为了「让动画更慢一点」而改到它，就把文案的可读
 * 时间一起改了。（§4.5 明文：「自动关闭时长为组件内命名常量、不做 CSS 令牌」。）
 *
 * 依据：普通 5s；带操作 8s——用户需要读完整句、判断是否撤销、再把指针移过去。
 */
const AUTO_DISMISS_MS = {
  plain: 5000,
  withAction: 8000,
} as const;

/**
 * 兜底移除上限（毫秒）。
 *
 * 作用不是"等动画"，而是防止 CSS 里的退场过渡被改坏（或压根没匹配上）时，
 * 这条提示永远停在退场中、既看不见又不释放槽位。与 `use-delayed-unmount`
 * 的兜底是同一个思路：**正常路径靠 `transitionend`，兜底路径靠定时器**。
 */
const FALLBACK_EXIT_MS = 1000;

export type ToastProps = {
  readonly record: ToastRecord;
  /** 请求关闭（幂等）：置为退场中。自动到时与点 × 都走这里。 */
  readonly onDismiss: (id: string) => void;
  /** 已经退场，可以从队列里摘掉了。 */
  readonly onExited: (id: string) => void;
};

/**
 * 单条提示（UI-002 批次 3b，《UI 页面规范》§4.5）。
 *
 * ## 它不管队列，只管自己这一条
 *
 * 队列长度、3 条上限、淘汰谁，全在 `ToastProvider` 里——单条组件去关心
 * 「我是不是被挤掉的那个」会立刻需要知道邻居，而那是队列的职责。
 * 反过来，这一条自己管的是**只跟自己有关**的三件事：计时、暂停、退场时机。
 *
 * ## 计时器为什么在单条里而不是队列里
 *
 * 「指针悬停或焦点进入时暂停」要求知道**自己的 DOM 元素**收到了这些事件。
 * 放在队列里就得把事件从每条冒泡上去、再按 id 映射回来，凭空多一层簿记；
 * 放在这里，容器上的 `onMouseEnter` / `onFocus` 直接就是答案。
 *
 * 代价是「移出后**重新计时**」而不是接着剩余时间走——这一版按重新计时实现，
 * 它更简单，而且对「用户刚把指针移开」这个场景更宽容。
 */
export function Toast({ record, onDismiss, onExited }: ToastProps) {
  const { id, message, variant, action, closing } = record;
  const [paused, setPaused] = useState(false);

  /**
   * 本条多久自动关闭。`null` = 常驻。
   *
   * 错误态常驻是硬要求（NFR-REL-002：失败必须明确提示），只能由用户点 ×
   * 或代码 `dismiss(id)` 收掉——「失败提示自己悄悄消失」正是这条要求要防的事。
   */
  const dismissAfterMs =
    variant === 'danger'
      ? null
      : action === undefined
        ? AUTO_DISMISS_MS.plain
        : AUTO_DISMISS_MS.withAction;

  useEffect(() => {
    if (closing || paused || dismissAfterMs === null) {
      return undefined;
    }

    const timer = setTimeout(() => {
      onDismiss(id);
    }, dismissAfterMs);

    return () => {
      clearTimeout(timer);
    };
  }, [closing, paused, dismissAfterMs, onDismiss, id]);

  useEffect(() => {
    if (!closing) {
      return undefined;
    }

    // 兜底：`transitionend` 没来也要把槽位还回去。
    const timer = setTimeout(() => {
      onExited(id);
    }, FALLBACK_EXIT_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [closing, onExited, id]);

  function handleTransitionEnd(event: TransitionEvent<HTMLDivElement>): void {
    // 只认本条**自身**的过渡结束：里面的按钮 hover 过渡会冒泡上来，
    // 不拦住就会在退场还没发生时把提示摘掉。
    if (event.target === event.currentTarget && closing) {
      onExited(id);
    }
  }

  return (
    <div
      className={styles.toast}
      data-state={closing ? 'closed' : 'open'}
      data-variant={variant}
      data-toast-id={id}
      // 每条自己就是 live region，外层容器**不再**套 `aria-live`：
      // 嵌套的 live region 会让同一条消息被播报两次。
      role={variant === 'danger' ? 'alert' : 'status'}
      onTransitionEnd={handleTransitionEnd}
      onMouseEnter={() => {
        setPaused(true);
      }}
      onMouseLeave={() => {
        setPaused(false);
      }}
      // React 的 `onFocus` / `onBlur` 本身就是冒泡语义（等价 focusin/focusout），
      // 挂在容器上即可覆盖内部的按钮——键盘用户 Tab 进操作槽时同样不会被抢走。
      onFocus={() => {
        setPaused(true);
      }}
      onBlur={() => {
        setPaused(false);
      }}
    >
      <ToastIcon variant={variant} />

      <p className={styles.message}>{message}</p>

      {action === undefined ? null : (
        <button
          type="button"
          className={styles.action}
          data-variant="toast-action"
          onClick={() => {
            action.onClick();
            // 操作已执行，这条提示的使命结束——不关掉的话用户会以为还没处理。
            onDismiss(id);
          }}
        >
          {action.label}
        </button>
      )}

      <IconButton
        label="关闭提示"
        onClick={() => {
          onDismiss(id);
        }}
        data-variant="toast-close"
      >
        ×
      </IconButton>
    </div>
  );
}

/**
 * 前导图标：**状态变体唯一的视觉区分手段**。
 *
 * §4.5 冻结了提示条的底是「表面色底」，所以不能像 Badge 那样铺一层
 * `--color-*-soft`——那会直接违反冻结文本。这里只让图标带状态色，
 * 正文保持 `--color-text-primary`（不做整条红字，符合 §1.1 的克制基调）。
 *
 * 普通态**不配图标**：它是信息密度最低的一条，加图标只会让页面底部更吵。
 *
 * SVG 内联而不是引图标库：项目没有图标依赖，为此拉一个包不划算；
 * 用 `currentColor` + CSS 侧上色，颜色也就回到了令牌体系里。
 */
function ToastIcon({ variant }: { readonly variant: ToastVariant }) {
  if (variant === 'info') {
    return null;
  }

  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {variant === 'success' ? (
        <path
          d="M3.5 8.5 6.5 11.5 13 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.75V8.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="11.25" r="0.9" fill="currentColor" />
        </>
      )}
    </svg>
  );
}
