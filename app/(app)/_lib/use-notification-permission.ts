'use client';

import { useCallback, useSyncExternalStore } from 'react';

import type { NotificationPermissionStatus } from '@/shared/ui/components';

export interface UseNotificationPermissionResult {
  /**
   * 当前权限状态；`null` 表示**尚未测定**（服务端渲染与首帧）。
   *
   * 刻意不用「默认 granted」起步：那会让首帧的降级提示闪一下「已授权」再翻成
   * 「未开启」，更糟的是会让触达派发在真实权限未知时就去构造通知，把一次
   * `PERMISSION_DENIED` 误记成 `CONSTRUCT_FAILED`。
   */
  readonly permission: NotificationPermissionStatus | null;
  /** 请求权限（真实动作，必须由用户手势触发）。 */
  readonly requestPermission: () => void;
}

/** 订阅者集合（外部数据源的最小形态，只有"重新读一次"这一种通知）。 */
const listeners = new Set<() => void>();

/**
 * 读取并请求浏览器通知权限（UI v0.23 §5 D 的权限状态处）。
 *
 * ## 为什么是 `useSyncExternalStore` 而不是 `useState` + `useEffect`
 *
 * `Notification.permission` 是**浏览器专有的外部数据源**，且在服务端渲染时根本
 * 不存在。用 `useState(null)` + 挂载后 `setState` 回填，会在 effect 里同步 setState
 * （React 19 的 `set-state-in-effect` 检查明确禁止——它会造成级联渲染）；而把初值
 * 直接写成 `readPermission()` 又会让服务端与客户端首帧取值不同，触发水合不匹配。
 *
 * `useSyncExternalStore` 恰好同时解决这两件事：`getServerSnapshot` 给水合帧一个
 * 确定的 `null`，水合完成后 React 自动用 `getSnapshot` 读一次真实值并重渲染，
 * 全程不需要在 effect 里写状态。
 *
 * ## 权限变化靠什么发现
 *
 * 浏览器**不为权限变更发事件**。订阅的是 `visibilitychange`——用户去浏览器站点
 * 设置里改权限时必然离开过本页，回来时重读是唯一可靠的时机；另外
 * `requestPermission()` 自己会主动通知一次。
 *
 * ## 为什么 `default` 与 `denied` 都算「未开启」
 *
 * D 节冻结的降级文案只有两条（不支持 / 权限未开启）；`default`（还没问过）与
 * `denied`（问过被拒）在产品语义上都落在「系统通知权限未开启」——两者都提供
 * 同一枚「重新请求权限」次按钮，不额外造第三种提示。
 */
export function useNotificationPermission(): UseNotificationPermissionResult {
  const permission = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const requestPermission = useCallback(() => {
    if (typeof Notification === 'undefined') {
      return;
    }
    void Notification.requestPermission()
      .then(() => {
        emit();
      })
      .catch(() => {
        // 请求本身失败（非用户拒绝，如非安全上下文）：重读一次仍是原状态，
        // 提示因此保持不变、不循环弹窗骚扰（D 节「请求仍失败则保持本提示」）。
        emit();
      });
  }, []);

  return { permission, requestPermission };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  document.addEventListener('visibilitychange', listener);
  return () => {
    listeners.delete(listener);
    document.removeEventListener('visibilitychange', listener);
  };
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): NotificationPermissionStatus {
  return readPermission();
}

/** 水合帧一律「尚未测定」：服务端没有 `Notification`，此时任何取值都是猜的。 */
function getServerSnapshot(): NotificationPermissionStatus | null {
  return null;
}

/** 读一次权限；不支持 Notification 的运行时一律归为 `unsupported`。 */
function readPermission(): NotificationPermissionStatus {
  if (typeof Notification === 'undefined') {
    return 'unsupported';
  }
  const value: string = Notification.permission;
  if (value === 'granted' || value === 'denied' || value === 'default') {
    return value;
  }
  return 'unsupported';
}
