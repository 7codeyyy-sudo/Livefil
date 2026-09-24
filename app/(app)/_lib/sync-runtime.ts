'use client';

/**
 * 同步运行时装配（SYNC-002 / SYNC-003 / SYNC-004）。
 *
 * ## 它把三块拼在一起
 *
 * 1. **本地存储**：由根级 `client-composition-root.ts` 提供（IndexedDB，SSR 回退内存）；
 * 2. **传输**：本文件用 `api-client` 实现 `SyncTransport` 端口（三条 HTTP 调用）；
 * 3. **引擎**：`src/modules/sync/application/sync-client.ts`（应用层，不认识 React）。
 *
 * ## 为什么要单例
 *
 * 队列快照是"外部可变数据源"，多个消费者必须看到**同一份**队列；而每建一个
 * 引擎就多一份内存里的快照与一批订阅者。单例通过 `getSyncClient()` 暴露，
 * 由 `SyncStatusContainer` 在渲染时取用。
 *
 * ## 为什么写请求的入队接线也在这里
 *
 * `api-client` 不认识同步模块（它对一个模块内部产生依赖是不必要的），它只暴露
 * `setSyncWriteSink`。把"谁来实现这个回调"放在装配点，是组合根存在的意义。
 * 接线发生在首次取用引擎时——那时浏览器环境已确定，本地存储也真的可用了。
 */
import {
  createSyncClient,
  type ConflictResolutionChoice,
  type SyncClient,
  type SyncPullPage,
  type SyncPushOperation,
  type SyncPushResult,
  type SyncTransport,
} from '@/modules/sync/application/sync-client.ts';

import { fetchJson, sendJson, setSyncWriteSink } from './api-client';
import { getLocalStore } from '../../../client-composition-root.ts';

/**
 * 拉取用的信号：**永不作废**。
 *
 * `fetchJson` 的签名要求一个调用方信号（页面取数用它做卸载作废），而后台同步
 * 没有"卸载"这件事——它只该被自己的超时兜住。传一个永不 abort 的信号，
 * 超时仍由 `fetchJson` 内部叠加，语义因此与页面取数一致而不多一条取消路径。
 */
const NEVER_ABORTED = new AbortController();

/** 三条同步端点的传输实现（《接口文档》§12）。 */
const transport: SyncTransport = {
  async push(operations: readonly SyncPushOperation[]): Promise<readonly SyncPushResult[]> {
    const envelope = await sendJson<{ readonly results: readonly SyncPushResult[] }>(
      'POST',
      '/api/v1/sync/push',
      { operations },
    );
    return envelope.data.results;
  },

  pull(cursor: string | null, limit: number): Promise<SyncPullPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor !== null) {
      params.set('cursor', cursor);
    }
    // 游标原样回传（契约明示它对客户端不透明），拼进查询串时必须转义。
    return fetchJson<SyncPullPage>(
      `/api/v1/sync/pull?${params.toString()}`,
      NEVER_ABORTED.signal,
    ).then((envelope) => envelope.data);
  },

  async resolve(conflictId: string, resolution: ConflictResolutionChoice): Promise<void> {
    await sendJson('POST', `/api/v1/sync/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
      resolution,
    });
  },
};

let syncClient: SyncClient | null = null;

/** 同步引擎单例（并在首次取用时完成写请求入队的接线）。 */
export function getSyncClient(): SyncClient {
  if (syncClient !== null) {
    return syncClient;
  }

  const client = createSyncClient({ store: getLocalStore(), transport });
  syncClient = client;

  // 写请求没能送达服务端时，`api-client` 把这条编辑送到这里入队。
  // 入队失败（配额耗尽等）由 `api-client` 兜住，不影响它原本要抛出的错误。
  setSyncWriteSink((descriptor) => client.enqueueWrite(descriptor));

  return client;
}
