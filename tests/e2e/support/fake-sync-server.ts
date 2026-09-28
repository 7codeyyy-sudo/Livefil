/**
 * 假同步服务端（测试点 13 · SYNC-005 局域网复核）。
 *
 * ## 它是什么
 *
 * 一个**进程内的内存后端**：接到某个 Playwright `BrowserContext` 的全部页面上，
 * 扮演 `GET /tasks` / `POST /tasks` / `POST /sync/push` / `GET /sync/pull` 四条
 * 端点。两个 context 共用**同一个实例**，就等价于「两台设备连同一后端」——
 * 这正是本机没有第二台真机时的替代物（测试点 13 的执行条件）。
 *
 * ## 它**不**验证什么（避免把假实现当真覆盖）
 *
 * 真正的服务端语义——事务落库、`sync:` 幂等键的唯一约束、版本号单调递增、CAS
 * 冲突判定、`already_applied` 的版本回读——**都不在这里**。它们是服务端事实，
 * 应由集成/db 层用例（`§6.3` 真机实测口径）承担；在浏览器层用 stub 复刻它们
 * 再断言，等于断言自己写的假实现。
 *
 * 因此本模块只提供「另一端刷新时能看见服务端返回的项」这一**客户端可验证的事实**：
 * 客户端发出的写（在线 POST、离线 push）是否真的进了后端，以及另一端刷新取数
 * 能否把它渲染出来。
 *
 * 文件名不含 `.spec.ts`，Playwright 不会把它当作用例文件收集。
 */
import { randomUUID } from 'node:crypto';

import type { BrowserContext } from '@playwright/test';

import { fulfillJson, readPushBody } from './sync-stub';

/** 空今日聚合（与 `sync-stub.ts` 同一份空形态）。 */
const EMPTY_TODAY = {
  date: '2026-01-01',
  currentAction: null,
  blocks: [],
  fixedCommitments: [],
  unscheduledTasks: [],
  routines: [],
  habits: [],
  load: {
    fixedMinutes: 0,
    plannedMinutes: 0,
    completedMinutes: 0,
    availableMinutes: 960,
    overloaded: false,
  },
  recovery: { manual: false, since: null, autoTriggered: false, suggestions: [] },
};

/** 收件箱渲染需要的最小任务字段（`queries.ts` 的 `TaskItem`）。 */
export type FakeTaskRow = {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dueDate: null;
  readonly estimatedMinutes: null;
  readonly minimumVersion: null;
  readonly lifeAreaId: null;
  readonly goalId: null;
  readonly version: number;
};

function toRow(id: string, payload: Readonly<Record<string, unknown>>): FakeTaskRow {
  const title =
    typeof payload.title === 'string' && payload.title !== '' ? payload.title : '未命名任务';
  return {
    id,
    title,
    status: 'inbox',
    dueDate: null,
    estimatedMinutes: null,
    minimumVersion: null,
    lifeAreaId: null,
    goalId: null,
    version: 1,
  };
}

export class FakeSyncServer {
  readonly #tasks = new Map<string, FakeTaskRow>();

  /** 后端当前已落的任务（按创建顺序）。用例据此断言「另一端是否真的收到了写」。 */
  list(): readonly FakeTaskRow[] {
    return [...this.#tasks.values()];
  }

  /** 把本后端接到一个 context 的全部页面上。两个 context 共用同一实例即为「同一后端」。 */
  async install(context: BrowserContext): Promise<void> {
    await context.route('**/api/v1/today*', (route) =>
      fulfillJson(route, { data: EMPTY_TODAY, meta: { requestId: 'e2e' } }),
    );

    // 收件箱列表：返回当前后端里已有的任务（另一端刷新据此可见）。
    await context.route('**/api/v1/tasks?*', (route) =>
      fulfillJson(route, {
        data: { items: this.list() },
        meta: { nextCursor: null, hasMore: false },
      }),
    );

    // 在线创建：直接落行并回信封。
    await context.route('**/api/v1/tasks', (route) => {
      if (route.request().method() !== 'POST') {
        return route.continue();
      }
      const body = route.request().postDataJSON() as unknown;
      const payload =
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const row = toRow(randomUUID(), payload);
      this.#tasks.set(row.id, row);
      return fulfillJson(route, { data: row, meta: { requestId: 'e2e' } });
    });

    // 离线队列推送：`create` 以**客户端生成的 entityId** 落行（《接口文档》§12 口径）。
    await context.route('**/api/v1/sync/push', async (route) => {
      const { operations } = readPushBody(route);
      const results = operations.map((operation) => {
        if (operation.operationType === 'create') {
          this.#tasks.set(operation.entityId, toRow(operation.entityId, operation.payload));
        }
        return { operationId: operation.operationId, status: 'applied' as const, version: 1 };
      });
      await fulfillJson(route, { data: { results }, meta: { requestId: 'e2e' } });
    });

    await context.route('**/api/v1/sync/pull*', (route) =>
      fulfillJson(route, { data: { changes: [], nextCursor: null }, meta: { requestId: 'e2e' } }),
    );
  }
}
