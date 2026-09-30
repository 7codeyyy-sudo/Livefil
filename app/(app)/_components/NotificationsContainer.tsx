'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  NotificationBell,
  PendingNotificationsDrawer,
  useAsyncQuery,
  useToast,
} from '@/shared/ui/components';
import type {
  AsyncQueryState,
  NotificationPermissionStatus,
  PendingNotificationRow,
} from '@/shared/ui/components';

import {
  EMPTY_NAME_MAPS,
  NOTIFICATION_LEVEL_LABELS,
  dismissNotification,
  fetchPendingNotifications,
  fetchTargetNameMaps,
  formatNotificationTime,
  notificationTargetHref,
  reportNotificationAttempt,
  resolveTargetName,
} from '../_lib/notifications-api';
import type {
  NotificationErrorCode,
  NotificationLevel,
  PendingNotificationItem,
  TargetNameMaps,
} from '../_lib/notifications-api';
import { useNotificationPermission } from '../_lib/use-notification-permission';

/** 面板取数的结果：待处理条目 + 用于补名的对象名表。 */
interface PanelData {
  readonly pending: readonly PendingNotificationItem[];
  readonly names: TargetNameMaps;
}

/** 前台通知的正文（标题是对象名，正文给一句到哪去看）。 */
const BROWSER_NOTIFICATION_BODY = '打开应用可查看待处理提醒。';

/** 轮询间隔：提醒是低频信息，60s 足够近似"到点弹出"，又不至于持续打服务端。 */
const POLL_INTERVAL_MS = 60_000;

/**
 * 待处理提醒容器（NOTIFY-002，《UI 页面规范》v0.23 §5 B）。
 *
 * ## 它同时是三条线的唯一挂载点
 *
 * 1. **面板**：顶栏铃铛（未读数 = 列表条数）+ `Drawer` 列表；
 * 2. **物化触发**：`GET /notifications/pending` 的读路径本身就会物化到点的规则
 *    （RD-20260929-008「补正 1」），所以"刷新面板"就是"生成提醒"，没有额外的
 *    生成端点；
 * 3. **前台触达派发**：对到点的交付构造浏览器通知，并把成败事实交回第 8 端点。
 *
 * ## 名称为什么在同一个请求里取
 *
 * §16 的 pending 载荷**不携带对象名**（只有 `targetType` / `targetId`），而 §5 B
 * 要求「标题＝对象名」。客户端只能自己补：`GET /tasks?limit=100` + `GET /routines`
 * 各一条建表（逐 id 取会退化成 N+1），解析不到就回落类别名。它和待处理列表放在
 * **同一次取数**里，是为了让"标题补名"与"派发"共用同一份快照——两份数据各自
 * 取数时，派发可能拿着过期的名字。
 *
 * 名称表失败**不算面板失败**（`.catch` 回落空表）：取不到名字的后果只是标题退成
 * 「任务」「例程」，把整个面板判为错误并让用户看一条"加载失败"要糟得多。
 *
 * ## 触达派发为什么不需要额外的重试端点
 *
 * §16 第 8 端点的第 5 条派生规则里，服务端已经把"这一条还要不要重试"写进了
 * `next_retry_at`：可重试失败且未达上限给未来时刻，达上限或确定性失败给 `NULL`。
 * 因此客户端**只要照着 `nextRetryAt` 到点再报一次**即可，不必自己数次数、
 * 算退避——计数与终态判定的唯一权威在服务端（§16 明文）。
 *
 * ## 派发失败（网络层）为什么不能无限重试
 *
 * 上报本身失败时**不占坑、也不触发刷新**：占坑会让这一条本次会话内再不被尝试，
 * 触发刷新则会形成"上报失败 → 刷新 → 又到点 → 又上报"的紧循环。两者的取舍是
 * ——留给下一次 60s 轮询，节奏由轮询决定。
 */
export function NotificationsContainer() {
  const [open, setOpen] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const toast = useToast();
  const { permission } = useNotificationPermission();

  /**
   * 本次页面会话已上报过的尝试键。
   *
   * 键里带 `nextRetryAt`：服务端每接受一次上报就会改写它（或置 `NULL`），因此
   * 同一条交付的下一次重试天然换了一个键，不必清空这个集合；而"上报失败的
   * 那一次"不入集合，下次轮询可以再来。
   */
  const attemptedRef = useRef<Set<string>>(new Set());

  const queryFn = useCallback(async (signal: AbortSignal): Promise<PanelData> => {
    const pending = await fetchPendingNotifications(signal);
    const names = await fetchTargetNameMaps(signal).catch(() => EMPTY_NAME_MAPS);
    return { pending: pending.data, names };
  }, []);

  const query = useAsyncQuery<PanelData>({ queryKey: ['notifications', 'panel'], queryFn });
  const refetch = query.refetch;

  // 派生出的两个稳定引用（`query.state` 在 loading 态每次渲染都是新对象，
  // 直接进依赖会让派发 effect 每渲染跑一遍）。
  const pending = query.state.status === 'success' ? query.state.data.pending : null;
  const names = query.state.status === 'success' ? query.state.data.names : null;

  // 触达派发：状态落定后才跑，每次落定最多让每条"到点且未尝试过"的交付报一次。
  useEffect(() => {
    if (pending === null || names === null) {
      return;
    }
    void dispatchDueAttempts(pending, names, permission, attemptedRef.current).then((reported) => {
      // 只在上报**成功**后刷新：拿到服务端的权威新态（`next_retry_at` 是否续期、
      // 是否已 sent）后，未到点的条目不满足"到点"判据，循环因此自然停在这里。
      if (reported) {
        refetch();
      }
    });
  }, [pending, names, permission, refetch]);

  // 轮询 + 页面重新可见时刷新：提醒要"到点就出现"，而轮询是唯一的时钟。
  useEffect(() => {
    const timer = window.setInterval(refetch, POLL_INTERVAL_MS);

    function onVisibilityChange(): void {
      if (document.visibilityState === 'visible') {
        refetch();
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refetch]);

  const drawerState: AsyncQueryState<readonly PendingNotificationRow[]> =
    query.state.status === 'success'
      ? { status: 'success', data: toRows(query.state.data.pending, query.state.data.names) }
      : query.state;

  const unreadCount = drawerState.status === 'success' ? drawerState.data.length : 0;

  const handleDismiss = useCallback(
    (deliveryId: string): void => {
      setDismissing(true);
      void dismissNotification(deliveryId)
        .then(() => {
          refetch();
        })
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : '操作失败，请稍后重试');
        })
        .finally(() => {
          setDismissing(false);
        });
    },
    [refetch, toast],
  );

  const handleDismissAll = (): void => {
    if (drawerState.status !== 'success') {
      return;
    }
    setDismissing(true);
    // 逐条 dismiss：§16 没有批量端点，这里不做"本地先清空"的乐观更新——
    // 一条失败就意味着服务端仍会把它读回来，乐观清空只会让条目闪回。
    void Promise.all(
      drawerState.data.map((row) => dismissNotification(row.deliveryId).catch(() => undefined)),
    )
      .then(() => {
        refetch();
      })
      .finally(() => {
        setDismissing(false);
      });
  };

  return (
    <>
      {/*
        铃铛与面板同出一个容器：面板只是 `Drawer`，它经 `OverlayPortal` 挂到
        `body`（同 `MobileNavDrawer` 的说明），所以这个片段整体作为顶栏的
        `notificationBell` 槽渲染，抽屉也不会真的挤在页头里。
      */}
      <NotificationBell
        unreadCount={unreadCount}
        open={open}
        onClick={() => {
          setOpen(true);
        }}
      />

      <PendingNotificationsDrawer
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        state={drawerState}
        onRetry={refetch}
        onDismiss={handleDismiss}
        onDismissAll={handleDismissAll}
        dismissing={dismissing}
      />
    </>
  );
}

/** §16 载荷 + 名称表 → 面板行。 */
function toRows(
  items: readonly PendingNotificationItem[],
  names: TargetNameMaps,
): readonly PendingNotificationRow[] {
  return items.map((item) => ({
    deliveryId: item.deliveryId,
    level: toLevel(item.level),
    levelLabel: NOTIFICATION_LEVEL_LABELS[toLevel(item.level)],
    title: resolveTargetName(names, item.targetType, item.targetId),
    time: formatNotificationTime(item.scheduledFor),
    summary: describe(item),
    href: notificationTargetHref(item.targetType),
  }));
}

/** 等级取值兜底：服务端只可能给三值，越界时按最低档呈现而不是崩掉面板。 */
function toLevel(value: string): NotificationLevel {
  if (value === 'critical' || value === 'normal' || value === 'review') {
    return value;
  }
  return 'normal';
}

/** 一行简述：触达渠道与最近一次失败的处置状态（不暴露重试细节，§5 B）。 */
function describe(item: PendingNotificationItem): string {
  if (item.status === 'failed') {
    return '系统通知未能送达，已在应用内显示。';
  }
  return '等待发送系统通知。';
}

/** 一次尝试的去重键（见 `attemptedRef` 的说明）。 */
function attemptKey(item: PendingNotificationItem): string {
  return `${item.deliveryId}|${item.status}|${item.nextRetryAt ?? 'none'}`;
}

/** 这条交付此刻是否该尝试一次前台通知。 */
export function isAttemptDue(item: PendingNotificationItem, nowMs: number): boolean {
  if (item.status === 'pending') {
    return Date.parse(item.scheduledFor) <= nowMs;
  }
  if (item.status === 'failed') {
    // `nextRetryAt` 为 `null` 是服务端的"到此为止"（达上限或确定性失败），
    // 不是"没排上"——所以这里不尝试，也不去猜次数。
    return item.nextRetryAt !== null && Date.parse(item.nextRetryAt) <= nowMs;
  }
  return false;
}

/** 一次尝试的处置计划（纯函数，便于逐分支对照 §5 D 与 §16 第 8 端点）。 */
export type BrowserAttemptPlan =
  | { readonly kind: 'skip' }
  | { readonly kind: 'report'; readonly outcome: 'sent' }
  | {
      readonly kind: 'report';
      readonly outcome: 'failed';
      readonly errorCode: NotificationErrorCode;
    };

/**
 * 权限状态 → 这一次尝试该怎么报。
 *
 * | 权限 | 处置 | 理由 |
 * |---|---|---|
 * | `granted` | 构造通知；成功报 `sent`，抛错报 `NOTIFICATION_CONSTRUCT_FAILED` | 两个分支都是客户端实知的事实 |
 * | `denied` | 直接报 `NOTIFICATION_PERMISSION_DENIED` | PD-20260929-012 拍板 2 要的正是「权限失败的记录」 |
 * | `unsupported` | 直接报 `NOTIFICATION_UNSUPPORTED` | 同上，且 §16 判其确定性、不再重试 |
 * | `default` / 未测定 | 跳过，不落痕 | 用户**还没表态**；把"没问过"记成"被拒"就是往库里写假事实。会话内每轮轮询都会重判，授权后自然派发 |
 */
export function planBrowserAttempt(
  permission: NotificationPermissionStatus | null,
): BrowserAttemptPlan {
  if (permission === 'granted') {
    return { kind: 'report', outcome: 'sent' };
  }
  if (permission === 'denied') {
    return { kind: 'report', outcome: 'failed', errorCode: 'NOTIFICATION_PERMISSION_DENIED' };
  }
  if (permission === 'unsupported') {
    return { kind: 'report', outcome: 'failed', errorCode: 'NOTIFICATION_UNSUPPORTED' };
  }
  return { kind: 'skip' };
}

/**
 * 把当前到点且未尝试过的交付各派发一次。
 *
 * @returns 是否**至少成功上报过一次**——调用方据此决定要不要立刻刷新
 *   （见容器里那段说明：失败不刷新，避免紧循环）。
 */
async function dispatchDueAttempts(
  items: readonly PendingNotificationItem[],
  names: TargetNameMaps,
  permission: NotificationPermissionStatus | null,
  attempted: Set<string>,
): Promise<boolean> {
  const nowMs = Date.now();
  const due = items.filter((item) => !attempted.has(attemptKey(item)) && isAttemptDue(item, nowMs));

  let reported = false;

  await Promise.all(
    due.map(async (item) => {
      const plan = planBrowserAttempt(permission);
      if (plan.kind === 'skip') {
        return;
      }

      let outcome: 'sent' | 'failed' = 'sent';
      let errorCode: NotificationErrorCode | undefined;

      if (plan.outcome === 'sent') {
        const shown = notify(resolveTargetName(names, item.targetType, item.targetId));
        if (!shown) {
          outcome = 'failed';
          errorCode = 'NOTIFICATION_CONSTRUCT_FAILED';
        }
      } else {
        outcome = 'failed';
        errorCode = plan.errorCode;
      }

      try {
        await reportNotificationAttempt(
          item.deliveryId,
          errorCode === undefined ? { outcome } : { outcome, errorCode },
          // 每次尝试一个新键（§16 客户端纪律）：复用键会让网络层的自动重试
          // 撞上自己的重放（409），把一次尝试记成两次或干脆记失败。
          crypto.randomUUID(),
        );
        attempted.add(attemptKey(item));
        reported = true;
      } catch {
        // 上报没送到：服务端态未变，这一条下次轮询仍是"到点"，因此不占坑。
      }
    }),
  );

  return reported;
}

/** 构造一条前台通知；构造抛错即"这次没能送达"。 */
function notify(title: string): boolean {
  try {
    new Notification(title, { body: BROWSER_NOTIFICATION_BODY });
    return true;
  } catch {
    return false;
  }
}
