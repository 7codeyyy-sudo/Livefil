'use client';

import { AsyncState } from '../AsyncState/AsyncState';
import type { AsyncQueryState } from '../AsyncState/use-async-query';
import { Badge } from '../Badge/Badge';
import { Button } from '../Button/Button';
import { Drawer } from '../Drawer/Drawer';
import { Skeleton } from '../LoadingState/Skeleton';

import styles from './PendingNotificationsDrawer.module.css';

/** 面板条目的等级（与 §16 `level` 三值同域）。 */
export type PendingNotificationLevel = 'critical' | 'normal' | 'review';

/** 面板一行（由调用方从 §16 payload + 名称解析结果拼好）。 */
export interface PendingNotificationRow {
  readonly deliveryId: string;
  readonly level: PendingNotificationLevel;
  /** 等级的中文名（「关键」/「普通」/「复盘」）。 */
  readonly levelLabel: string;
  /** 对象名。 */
  readonly title: string;
  /** 触发时间（已按用户时区格式化）。 */
  readonly time: string;
  /** 一行简述。 */
  readonly summary: string;
  /** 对象真实落点。 */
  readonly href: string;
}

export type PendingNotificationsDrawerProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: AsyncQueryState<readonly PendingNotificationRow[]>;
  readonly onRetry: () => void;
  /** 「标记已读」与「忽略」共用的出口（见下说明）。 */
  readonly onDismiss: (deliveryId: string) => void;
  readonly onDismissAll: () => void;
  /** 任一 dismiss 请求在途：禁用行内行动作与「全部已读」，防连点。 */
  readonly dismissing: boolean;
};

/**
 * 应用内待处理提醒面板（《UI 页面规范》v0.23 §5 B）。
 *
 * ## 载体为什么是既有 `Drawer`
 *
 * B 节明文「下拉浮层非既有件，不新造方向与浮层机制」。所以这里只是 `Drawer`
 * 的内容填充，位移、遮罩、焦点陷阱、ESC 全部沿用 §4.5 的既有实现。
 *
 * ## 「标记已读」与「忽略」为什么接同一个出口
 *
 * §4.12 只有 `dismissed_at` 一列（没有独立的「已读」状态字段），§16 也只有
 * `POST /notifications/{deliveryId}/dismiss` 一个写入出口。两条动作在契约上
 * 必然收敛到同一处写入；本组件按 B 节冻结文本**保留两枚按钮**，但共用
 * `onDismiss`——不臆造一个契约里不存在的「已读」语义。
 *
 * ## 「点行跳转」怎么做到又保证行内按钮可点
 *
 * 行主链接用 stretched-link（`::after` 铺满整行）让整行可点，行内按钮在 DOM
 * 中位于链接之后且带 `position: relative`——同为定位元素时按 DOM 顺序绘制，
 * 按钮自然盖在链接的覆盖层之上，**不需要 z-index 字面量**（层级字面量在
 * tokens.css 之外是禁止的）。
 *
 * ## 四态
 *
 * loading＝行骨架；error＝「提醒列表加载失败」+ 既有「重试」；empty＝
 * 「没有待处理提醒」（无操作）；success＝列表。四态全部由 `AsyncState` 承载。
 */
export function PendingNotificationsDrawer({
  open,
  onClose,
  state,
  onRetry,
  onDismiss,
  onDismissAll,
  dismissing,
}: PendingNotificationsDrawerProps) {
  return (
    <Drawer open={open} onClose={onClose} title="待处理提醒">
      <AsyncState
        state={state}
        isEmpty={(rows) => rows.length === 0}
        // 空态按 B 节「（无操作）」：不给按钮。描述位必填（§4.6），给一句
        // 事实性说明而不是泛化文案（§1.1）。
        empty={{ title: '没有待处理提醒', description: '提醒到点后会出现在这里。' }}
        errorTitle="提醒列表加载失败"
        loading={
          <div className={styles.skeleton} data-variant="pending-skeleton">
            <Skeleton height="1.25em" />
            <Skeleton height="1.25em" />
            <Skeleton height="1.25em" />
          </div>
        }
        onRetry={onRetry}
        renderSuccess={(rows) => (
          <div className={styles.panel}>
            <div className={styles.toolbar}>
              <Button variant="secondary" disabled={dismissing} onClick={onDismissAll}>
                全部已读
              </Button>
            </div>

            <ul className={styles.list}>
              {rows.map((row) => (
                <li className={styles.item} key={row.deliveryId}>
                  <a className={styles.link} href={row.href}>
                    {row.title}
                  </a>

                  <p className={styles.meta}>
                    <Badge variant={row.level === 'critical' ? 'danger' : 'neutral'}>
                      {row.levelLabel}
                    </Badge>
                    <span className={styles.time}>{row.time}</span>
                  </p>

                  <p className={styles.summary}>{row.summary}</p>

                  <div className={styles.actions}>
                    <Button
                      variant="ghost"
                      disabled={dismissing}
                      onClick={() => {
                        onDismiss(row.deliveryId);
                      }}
                    >
                      标记已读
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={dismissing}
                      onClick={() => {
                        onDismiss(row.deliveryId);
                      }}
                    >
                      忽略
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      />
    </Drawer>
  );
}
