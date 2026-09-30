'use client';

import { Badge } from '../Badge/Badge';
import { IconButton } from '../IconButton/IconButton';

import styles from './NotificationBell.module.css';

export type NotificationBellProps = {
  /** 未读条数（＝面板内未被 `dismissed` 的条目数）；`0` 时不渲染角标。 */
  readonly unreadCount: number;
  /** 面板是否已展开——同步到 `aria-expanded`，供读屏与用例判断。 */
  readonly open: boolean;
  readonly onClick: () => void;
};

/**
 * 顶栏铃铛入口（《UI 页面规范》v0.23 §5 B）。
 *
 * ## 为什么是「IconButton + Badge」而不是新造一个组件
 *
 * B 节明文「IconButton/Badge 均为既有件，§3.2 原文不动」。这里只做两件既有件
 * 的组合，视觉取值全部落在令牌上，**零新增令牌**。
 *
 * ## 角标为什么用 `warning`
 *
 * §2.4 给 warning 的语义是「超载、冲突、待处理」——未读数正是「待处理」。
 * danger 在本规范里只留给删除/错误（§4.6），把一条计数涂红会稀释那个语义。
 * 角标里是**数字文字**，颜色不是唯一载体（§2.1）。
 */
export function NotificationBell({ unreadCount, open, onClick }: NotificationBellProps) {
  return (
    <span className={styles.root}>
      <IconButton
        label="待处理提醒"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onClick}
        data-variant="notification-bell"
      >
        <BellIcon />
      </IconButton>

      {unreadCount > 0 ? (
        <span className={styles.count} data-variant="notification-count">
          {/* 三位数以上折叠：角标宽度撑开会把铃铛挤出操作区。 */}
          <Badge variant="warning">{unreadCount > 99 ? '99+' : String(unreadCount)}</Badge>
        </span>
      ) : null}
    </span>
  );
}

/**
 * 铃铛图标件。
 *
 * 独立导出是刻意的：v0.23 §5 A 节要求对象行的触发件「复用 B 节顶栏铃铛同款
 * 图标件」（复用既有件优先，不新造 affordance），所以两处必须引用同一枚图标。
 *
 * 用 `currentColor` 内联 SVG 而不是 emoji：emoji 的实际字形由系统字体决定，
 * 颜色不受 `color` 控制，无法遵循 §2.1 的语义色纪律（同 `ErrorState` 的图标做法）。
 */
export function BellIcon() {
  return (
    <svg className={styles.glyph} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 2.1c1.9 0 3.4 1.5 3.4 3.4v2.2l1.1 2.1a.6.6 0 0 1-.5.9H4a.6.6 0 0 1-.5-.9l1.1-2.1V5.5c0-1.9 1.5-3.4 3.4-3.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M6.7 12.3a1.4 1.4 0 0 0 2.6 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
