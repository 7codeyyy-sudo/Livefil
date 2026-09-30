'use client';

import { Button } from '../Button/Button';

import styles from './NotificationPermissionNotice.module.css';

/**
 * 浏览器系统通知的权限状态。
 *
 * `unsupported` 是「运行时没有 Notification」，`default` 是「还没问过」，
 * `denied` 是「问过被拒」——后两者在 UI 上**共用同一条降级文案**（D 节只冻结了
 * 「不支持」与「未开启」两种说法）。
 */
export type NotificationPermissionStatus = 'unsupported' | 'default' | 'denied' | 'granted';

export type NotificationPermissionNoticeProps = {
  /** `null` 表示尚未测定（首帧）：此时**不渲染任何提示**，避免文案闪烁。 */
  readonly permission: NotificationPermissionStatus | null;
  /** 「重新请求权限」的动作。由调用方接 `useNotificationPermission`。 */
  readonly onRequestPermission: () => void;
};

/**
 * 触达降级提示（《UI 页面规范》v0.23 §5 D，**措辞冻结、逐字使用**）。
 *
 * ## 为什么不做成弹窗
 *
 * D 节明文「内嵌分区 4 与对象提醒区的权限状态处，非弹窗——不打断，§1 克制」。
 * 所以它是一行常驻说明，权限恢复后自行消失（`granted` 分支返回 `null`）。
 *
 * ## 为什么两种状态共用一枚按钮
 *
 * 「重新请求权限」只在**未开启**那条分支出现；浏览器不支持时没有可请求的对象，
 * 给了按钮就是假按钮（§1.1）。请求仍失败时保持本提示，不循环骚扰。
 */
export function NotificationPermissionNotice({
  permission,
  onRequestPermission,
}: NotificationPermissionNoticeProps) {
  if (permission === null || permission === 'granted') {
    return null;
  }

  if (permission === 'unsupported') {
    return (
      <p className={styles.text} data-variant="notification-unsupported">
        当前浏览器不支持系统通知，提醒将改为在应用内面板显示。
      </p>
    );
  }

  return (
    <div className={styles.root} data-variant="notification-permission">
      <p className={styles.text}>系统通知权限未开启，提醒将改为在应用内面板显示。</p>
      <Button variant="secondary" onClick={onRequestPermission}>
        重新请求权限
      </Button>
    </div>
  );
}
