'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type {
  ConflictResolutionChoice,
  SyncQueueSnapshot,
} from '@/modules/sync/application/sync-client.ts';
import {
  ConflictDialog,
  SyncStatusBanner,
  useOnlineStatus,
  useToast,
} from '@/shared/ui/components';
import type { SyncStatusBannerState } from '@/shared/ui/components';

import { getSyncClient } from '../_lib/sync-runtime';

/**
 * 同步状态容器（SYNC-002，《UI 页面规范》v0.20 §4.9.1）。
 *
 * ## 它是横幅的**唯一**挂载点
 *
 * §4.9.1 把「单容器、单挂载点、状态互斥」写成不可改变的口径。因此六态的优先级
 * 计算只在这里发生一次，`SyncStatusBanner` 拿到的是"已经选定的那一个状态"。
 *
 * ## 为什么状态不放在 React 里
 *
 * 队列是**外部可变数据源**（IndexedDB + 后台推送结果），订阅入口必须是
 * `useSyncExternalStore`（《详细设计说明书》§5.4.1）。用 `useState` + `useEffect`
 * 搬运会多出一份可能过期的副本，而且 SSR 阶段拿不到浏览器存储，首帧必然错一次。
 *
 * ## 刷新时机（§4.9.1 明文的四个）
 *
 * | 时机 | 这里的落点 |
 * |---|---|
 * | ① 网络恢复 | `window` 的 `online` 事件 |
 * | ② 页面重新可见 | `document` 的 `visibilitychange`（仅 `visible`） |
 * | ③ 用户点「立即同步」 | `handleSyncNow` |
 * | ④ 本地写操作入队 | `SyncClient.enqueueWrite` 内的 `refresh()` |
 *
 * **挂载不在其中**：这里只读一次已有队列（不发任何请求）。「自动重试仅在 ①②」
 * 也据此实现——入队与挂载都只刷新横幅，不顺手打一次注定可能失败的推送。
 * 队列为空时 `sync()` 直接返回，因此 ①② 在网络空闲的页面上不会产生任何流量。
 */
export function SyncStatusContainer() {
  const client = getSyncClient();
  const queue = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getServerSnapshot,
  );
  const online = useOnlineStatus();
  const toast = useToast();

  const [conflictOpen, setConflictOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  /** 出错后「重试」要重放的那一次选择（用户刚点过的那枚按钮）。 */
  const lastChoice = useRef<ConflictResolutionChoice | null>(null);

  useEffect(() => {
    void client.refresh();
  }, [client]);

  useEffect(() => {
    function autoSync(): void {
      void client.sync({ manual: false });
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === 'visible') {
        autoSync();
      }
    }

    window.addEventListener('online', autoSync);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('online', autoSync);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [client]);

  const handleSyncNow = useCallback((): void => {
    void client.sync({ manual: true }).then((result) => {
      // §4.9.1 的 Toast 分工：只有**用户手动**触发且这一轮没有传输失败时才提示；
      // 自动同步成功一律静默（横幅收起即反馈）。
      if (result.ok) {
        toast.success('同步完成');
      }
    });
  }, [client, toast]);

  const handleOpenConflicts = useCallback((): void => {
    setResolveError(null);
    setConflictOpen(true);
  }, []);

  const handleLater = useCallback((): void => {
    // §4.9.2 第 5 条：稍后处理 = 关闭弹层，冲突保留待处理、横幅计数不变。
    setConflictOpen(false);
    setResolveError(null);
  }, []);

  // 逐条处理：一次只面对一条冲突（§4.9.2 第 6 条「连续处理」）。
  const conflict = queue.conflicts[0] ?? null;

  const handleResolve = useCallback(
    (resolution: ConflictResolutionChoice): void => {
      if (conflict === null) {
        return;
      }
      lastChoice.current = resolution;
      setResolving(true);
      setResolveError(null);

      void client
        .resolveConflict(conflict.conflictId, resolution)
        .then(() => {
          // 快照已在 `resolveConflict` 内刷新过，这里读到的是解决之后的结果。
          const remaining = client.getSnapshot().conflicts.length;
          setConflictOpen(remaining > 0);
          if (remaining === 0) {
            toast.success('冲突已全部处理');
          }
        })
        .catch((error: unknown) => {
          // §4.9.2 第 7 条：就地插入错误行，**不**关闭弹层、不清空已选项。
          setResolveError(error instanceof Error ? error.message : '处理失败，请重试');
        })
        .finally(() => {
          setResolving(false);
        });
    },
    [client, conflict, toast],
  );

  const handleRetry = useCallback((): void => {
    const resolution = lastChoice.current;
    if (resolution !== null) {
      handleResolve(resolution);
    }
  }, [handleResolve]);

  const bannerState = computeBannerState(online, queue);

  return (
    <>
      {bannerState === null ? null : (
        <SyncStatusBanner
          state={bannerState}
          onSyncNow={handleSyncNow}
          onOpenConflicts={handleOpenConflicts}
        />
      )}

      {conflict === null ? null : (
        <ConflictDialog
          open={conflictOpen}
          entityName={conflict.entityName}
          local={conflict.local}
          server={conflict.server}
          pending={resolving}
          errorMessage={resolveError}
          onLater={handleLater}
          onKeepServer={() => handleResolve('keep_server')}
          onKeepLocal={() => handleResolve('keep_local')}
          onRetry={handleRetry}
        />
      )}
    </>
  );
}

/**
 * 队列 + 连通性 → 横幅状态；无可同步项时返回 `null`（容器整体不渲染）。
 *
 * 优先级逐条对应 §4.9.1 的「状态优先级」表：离线 → 冲突 → 被拒绝 → 失败 →
 * 同步中/待同步 → 无。抽成纯函数是为了让这张表可以被单独对照，而不必先起
 * 一个同步引擎。
 */
function computeBannerState(
  online: boolean,
  queue: SyncQueueSnapshot,
): SyncStatusBannerState | null {
  if (!online) {
    // 离线态独自占最高层：冲突处理、失败详情与重试都要网络，离线时一概不可操作。
    return { kind: 'offline' };
  }

  if (queue.conflicts.length > 0) {
    return { kind: 'conflict', count: queue.conflicts.length };
  }

  if (queue.rejected.length > 0) {
    return { kind: 'rejected', count: queue.rejected.length, items: queue.rejected };
  }

  if (queue.failedCount > 0) {
    return { kind: 'failed', count: queue.failedCount };
  }

  if (queue.syncing) {
    // 「同步中」压在「待同步」之上：同一层里进行中比等待更值得说。
    return { kind: 'syncing' };
  }

  if (queue.pendingCount > 0) {
    return { kind: 'pending', count: queue.pendingCount };
  }

  return null;
}
