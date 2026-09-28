/**
 * SYNC-005 局域网复核（测试点 13）。
 *
 * 验收项来自 RD-20260923-003 §6.3：
 * ① 一端创建、另一端刷新可见；② 一端离线创建、恢复网络后另一端可见；
 * ③ 同一 operationId 重放 push → 不二次递增；④ 冲突有明确提示、不静默覆盖。
 *
 * ## 「两台设备」怎么替代
 *
 * 本机没有第二台真机，用**同一浏览器的两个 `browser.newContext()`** 替代：两个
 * context 存储互不相通（各自的 IndexedDB），共同接到一个进程内的假后端
 * （`support/fake-sync-server.ts`），即为「两台设备连同一后端」。
 *
 * ## 每一项到底在验什么（决定诚实边界）
 *
 * - ① / ②：验的是**客户端**链路——「刷新取数 → 渲染」与「离线入队 → 联网回放 →
 *   另一端可见」。假后端只承担「写进去、再读出来」这一条，用它替代共享后端是
 *   本目录既有约定，不是自造结论。
 * - ③ / ④：验的同样是客户端侧契约——幂等键跨重试**稳定**、`already_applied` 被
 *   当作完成、冲突被显式呈现且本地版本不被静默丢弃。
 * - **不在此层伪装验证**的纯服务端语义：事务落库、`sync:` 幂等键的 DB 唯一约束、
 *   版本号单调递增（「不二次递增」）、CAS 冲突判定、`already_applied` 的版本回读。
 *   这些是服务端事实，由 §6.3 真机实测 / 集成层用例承担；在浏览器层用 stub 复刻
 *   它们再断言，等于断言自己写的假实现。故本文件不假装覆盖它们（另行上报）。
 *
 * ## 2026-09-28 重写
 *
 * 原文件是 describe 级 `test.skip` + 四条 `expect(true).toBe(true)`，且
 * `seedTask()` 打真实 `POST /api/v1/tasks`（CI 无库必挂，只因 skip 才没暴露）。
 * 现改为真跑真断言，全部落库请求经 `page.route` / `context.route` stub。
 */
import { expect, test } from '@playwright/test';

import { FakeSyncServer } from './support/fake-sync-server';
import {
  failTaskCreate,
  fulfillJson,
  quickAddTask,
  readPushBody,
  stubInboxData,
  stubPullEmpty,
  stubPush,
  type PushResult,
} from './support/sync-stub';

const SYNC_BANNER = '[data-sync-banner="true"]';
const OFFLINE_BANNER = '[data-offline-banner="true"]';
const SYNC_NOW = '立即同步';

test.describe('SYNC-005 局域网复核（测试点 13）', () => {
  test('① 一端创建、另一端刷新后可见', async ({ browser }) => {
    const server = new FakeSyncServer();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    await server.install(contextA);
    await server.install(contextB);
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await pageA.goto('/inbox');
      await expect(pageA.getByText('收件箱是空的')).toBeVisible();
      await pageB.goto('/inbox');
      await expect(pageB.getByText('收件箱是空的')).toBeVisible();

      // A 端在线创建（走后端 POST /tasks）。
      await quickAddTask(pageA, 'A 端创建的任务');
      await expect(pageA.getByText('A 端创建的任务')).toBeVisible();
      expect(server.list()).toHaveLength(1);

      // B 端刷新前不含这一条；刷新后从后端重新取数并渲染。
      await expect(pageB.getByText('A 端创建的任务')).toHaveCount(0);
      await pageB.reload();
      await expect(pageB.getByText('A 端创建的任务')).toBeVisible();
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('② 一端离线创建、恢复网络后另一端可见', async ({ browser }) => {
    const server = new FakeSyncServer();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    await server.install(contextA);
    await server.install(contextB);
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await pageA.goto('/inbox');
      await expect(pageA.getByText('收件箱是空的')).toBeVisible();
      await pageB.goto('/inbox');
      await expect(pageB.getByText('收件箱是空的')).toBeVisible();

      // 让 A 的创建始终在传输层失败 → 必然走本地入队（离线创建的客户端路径）。
      await failTaskCreate(pageA);

      await contextA.setOffline(true);
      await quickAddTask(pageA, '离线创建的任务');

      // 离线：写入本地队列并立即出现在 A 的列表里；后端此刻还没有这一行。
      await expect(pageA.locator(OFFLINE_BANNER)).toBeVisible();
      await expect(pageA.getByText('离线创建的任务')).toBeVisible();
      await expect(pageB.getByText('离线创建的任务')).toHaveCount(0);
      expect(server.list()).toHaveLength(0);

      // 恢复联网 → `online` 事件触发自动推送 → 后端以客户端 UUID 落行。
      await contextA.setOffline(false);
      await expect.poll(() => server.list().length).toBe(1);
      await expect(pageA.locator(SYNC_BANNER)).toHaveCount(0);

      await pageB.reload();
      await expect(pageB.getByText('离线创建的任务')).toBeVisible();
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('③ 同一 operationId 重放 push：幂等键跨重试稳定，already_applied 视为完成', async ({
    page,
  }) => {
    await stubInboxData(page);
    await failTaskCreate(page);
    await stubPullEmpty(page);
    await page.goto('/inbox');
    await expect(page.getByText('收件箱是空的')).toBeVisible();

    const sentIds: string[] = [];
    let attempt = 0;
    await page.route('**/api/v1/sync/push', async (route) => {
      const { operations } = readPushBody(route);
      for (const operation of operations) {
        sentIds.push(operation.operationId);
      }
      attempt += 1;
      if (attempt === 1) {
        // 第一轮：传输层失败 → 操作留在队列等重试（幂等键不得更换）。
        await route.abort('failed');
        return;
      }
      // 第二轮：服务端对同一 operationId 回 already_applied。
      const results: PushResult[] = operations.map((operation) => ({
        operationId: operation.operationId,
        status: 'already_applied',
        version: 1,
      }));
      await fulfillJson(route, { data: { results }, meta: { requestId: 'e2e' } });
    });

    await quickAddTask(page, '重放演示任务');

    const banner = page.locator(SYNC_BANNER);
    await expect(banner.getByText('1 条待同步')).toBeVisible();

    // 第一轮同步失败 → 横幅转「失败」，操作仍留在队列。
    await banner.getByRole('button', { name: SYNC_NOW }).click();
    await expect(banner.getByText('同步未完成，1 条内容仍保存在此设备')).toBeVisible();

    // 重试 → 第二轮 push 复用同一 operationId；客户端把 already_applied 当完成处理。
    await banner.getByRole('button', { name: SYNC_NOW }).click();
    await expect(page.locator(SYNC_BANNER)).toHaveCount(0);

    expect(sentIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sentIds).size, '同一操作重放必须复用同一幂等键').toBe(1);
  });

  test('④ 冲突有明确提示、不静默覆盖本地', async ({ page }) => {
    await stubPush(page, (body) =>
      body.operations.map((operation) => ({
        operationId: operation.operationId,
        status: 'conflict',
        conflictId: 'conflict-1',
        serverVersion: 2,
        serverPayload: { title: '服务器改过的标题', updatedAt: '2026-01-01T00:00:00.000Z' },
      })),
    );
    await stubPullEmpty(page);
    await stubInboxData(page);
    await failTaskCreate(page);
    await page.goto('/inbox');
    await expect(page.getByText('收件箱是空的')).toBeVisible();

    await quickAddTask(page, '冲突演示任务');
    const banner = page.locator(SYNC_BANNER);
    await expect(banner.getByText('1 条待同步')).toBeVisible();
    await banner.getByRole('button', { name: SYNC_NOW }).click();

    // 明确提示：横幅转 danger 并给出「查看并处理」，而不是静默覆盖或丢弃。
    await expect(banner).toHaveAttribute('data-tone', 'danger');
    await expect(banner.getByText('1 条内容与其他设备不一致，需要你选择保留哪一份')).toBeVisible();

    const openConflicts = banner.getByRole('button', { name: '查看并处理' });
    await expect(openConflicts).toBeVisible();
    await openConflicts.click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    // 两版并列且本地版本仍在：用户能选择保留它（本地改动未被静默丢弃）。
    await expect(dialog.getByText('此设备的版本')).toBeVisible();
    await expect(dialog.getByText('标题：冲突演示任务')).toBeVisible();
    await expect(dialog.getByText('服务器上的版本')).toBeVisible();

    // 「稍后处理」关闭弹层，冲突保留待处理（横幅计数不变，未被静默解决）。
    await dialog.getByRole('button', { name: '稍后处理' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(banner.getByText('1 条内容与其他设备不一致，需要你选择保留哪一份')).toBeVisible();
  });
});
