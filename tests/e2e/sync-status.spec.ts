/**
 * UI-008 规范符合性（测试点 15）。
 *
 * 验收项来自 RD-20260923-003 §3.2 / 《UI 页面规范》§4.9（横幅 §4.9.1、冲突弹层 §4.9.2）：
 * ① 六态横幅文案逐字对冻结文本；② 冲突浮层三按钮 + 说明行 + 初始焦点；
 * ③ Toast 分工（无「N 项修改待同步」/「已恢复联网」措辞）；④ 零新增令牌扫描。
 *
 * ## 2026-09-28 重写（原为空壳：`expect(true).toBe(true)`）
 *
 * 驱动各态的手法与理由：
 * - **离线态**：`context.setOffline(true)`。横幅由 `navigator.onLine` 驱动
 *   （`use-online-status.ts` 的 `useSyncExternalStore`），route 拦截改不了该值。
 * - **其余五态**：在线时让 `POST /api/v1/tasks` 在**传输层**失败 → 写操作进本地队列
 *   → 横幅由 `SyncStatusContainer.computeBannerState` 按优先级选态。再用不同的
 *   `/api/v1/sync/push`（前置通配的 glob 见 `support/sync-stub.ts`）应答分别造出
 *   「同步中 / 失败 / 被拒绝 / 冲突」。
 *   **不**用 route 假造离线，也不断言自造的假实现。
 *
 * ## 为什么全绿于无库环境
 *
 * CI 的 `browser-e2e` job 不带数据库。凡是会落库的请求都由 `page.route` stub
 * （见 `support/sync-stub.ts`），因此用例的成败只取决于被测客户端行为。
 */
import { expect, test, type Page } from '@playwright/test';

import {
  appliedAll,
  failTaskCreate,
  quickAddTask,
  stubInboxData,
  stubPullEmpty,
  stubPush,
  stubPushAbort,
} from './support/sync-stub';

/** 六态横幅（§4.9.1）里除离线态之外的五个共用这一个根标记。 */
const SYNC_BANNER = '[data-sync-banner="true"]';

/** 离线态沿用 §4.7 的离线横幅（§4.9.1 明文），DOM 上是另一个标记。 */
const OFFLINE_BANNER = '[data-offline-banner="true"]';

/** 冻结文案（`SyncStatusBanner.describeState` + `OfflineBanner`，逐字节照抄）。 */
const FROZEN = {
  offline: '当前处于离线状态，显示的内容可能不是最新',
  syncing: '同步中…',
  pending: '1 条待同步',
  failed: '同步未完成，1 条内容仍保存在此设备',
  rejected: '1 条内容同步被拒绝，仍保存在此设备',
  conflict: '1 条内容与其他设备不一致，需要你选择保留哪一份',
} as const;

const SYNC_NOW = '立即同步';

/** 进入已加载完成的收件箱，并让「快速添加」在传输层失败（写操作会进本地队列）。 */
async function gotoInboxWithFailedWrites(page: Page): Promise<void> {
  await stubInboxData(page);
  await failTaskCreate(page);
  await page.goto('/inbox');
  await expect(page.getByText('收件箱是空的')).toBeVisible();
}

/** 一条冲突 push 应答所需的固定服务端版本（冲突浮层与横幅共用）。 */
const CONFLICT_RESULT = {
  conflictId: 'conflict-1',
  serverVersion: 2,
  serverPayload: { title: '服务器改过的标题', updatedAt: '2026-01-01T00:00:00.000Z' },
} as const;

test.describe('UI-008 规范符合性（测试点 15）', () => {
  test('离线态横幅文案冻结，且不与同步横幅叠加', async ({ context, page }) => {
    await stubInboxData(page);
    // 恢复联网会触发一轮自动同步（队列为空 → 只拉不推），把 pull 一并 stub 掉。
    await stubPullEmpty(page);
    await page.goto('/inbox');
    await expect(page.getByText('收件箱是空的')).toBeVisible();

    await context.setOffline(true);

    const offlineBanner = page.locator(OFFLINE_BANNER);
    await expect(offlineBanner).toBeVisible();
    await expect(offlineBanner).toHaveAttribute('role', 'status');
    await expect(offlineBanner).toHaveText(FROZEN.offline);
    // §4.9.1「单容器、单挂载点、状态互斥」：离线态下不出现另一条同步横幅。
    await expect(page.locator(SYNC_BANNER)).toHaveCount(0);

    await context.setOffline(false);
    await expect(offlineBanner).toHaveCount(0);
  });

  test('待同步态：「1 条待同步」+「立即同步」入口，且入队不顺手推送', async ({ page }) => {
    let pushRequests = 0;
    await stubPush(page, appliedAll, {
      onRequest: () => {
        pushRequests += 1;
      },
    });
    await gotoInboxWithFailedWrites(page);

    await quickAddTask(page, '待同步演示任务');

    const banner = page.locator(SYNC_BANNER);
    await expect(banner).toHaveAttribute('role', 'status');
    await expect(banner).toHaveAttribute('data-tone', 'warning');
    await expect(banner.getByText(FROZEN.pending)).toBeVisible();
    await expect(banner.getByRole('button', { name: SYNC_NOW })).toBeVisible();

    // §4.9.1 时机纪律：挂载与入队只刷新横幅，不顺手打一次推送。
    expect(pushRequests, '入队与挂载不得触发推送').toBe(0);
  });

  test('同步中态：「同步中…」+ 按钮表达进度，完成后横幅收起', async ({ page }) => {
    await stubPush(page, appliedAll, { delayMs: 1500 });
    await stubPullEmpty(page);
    await gotoInboxWithFailedWrites(page);

    await quickAddTask(page, '同步中演示任务');

    const banner = page.locator(SYNC_BANNER);
    const syncNow = banner.getByRole('button', { name: SYNC_NOW });
    await expect(banner.getByText(FROZEN.pending)).toBeVisible();

    await syncNow.click();

    await expect(banner).toHaveAttribute('data-tone', 'warning');
    await expect(banner.getByText(FROZEN.syncing)).toBeVisible();
    // 同步中：按钮自己表达进度（loading → aria-busy + 禁用，防连点）。
    await expect(syncNow).toHaveAttribute('aria-busy', 'true');
    await expect(syncNow).toBeDisabled();

    // 推送完成后队列清空 → 横幅整体收起。
    await expect(page.locator(SYNC_BANNER)).toHaveCount(0);
  });

  test('失败态：「同步未完成，N 条内容仍保存在此设备」', async ({ page }) => {
    await stubPushAbort(page);
    await stubPullEmpty(page);
    await gotoInboxWithFailedWrites(page);

    await quickAddTask(page, '失败演示任务');

    const banner = page.locator(SYNC_BANNER);
    await banner.getByRole('button', { name: SYNC_NOW }).click();

    await expect(banner).toHaveAttribute('data-tone', 'warning');
    await expect(banner.getByText(FROZEN.failed)).toBeVisible();
  });

  test('被拒绝态：「N 条内容同步被拒绝…」+「查看详情」列出条目与原因', async ({ page }) => {
    await stubPush(page, (body) =>
      body.operations.map((operation) => ({
        operationId: operation.operationId,
        status: 'rejected',
        reason: '缺少必填字段',
      })),
    );
    await stubPullEmpty(page);
    await gotoInboxWithFailedWrites(page);

    await quickAddTask(page, '被拒演示任务');

    const banner = page.locator(SYNC_BANNER);
    await banner.getByRole('button', { name: SYNC_NOW }).click();

    await expect(banner).toHaveAttribute('data-tone', 'danger');
    await expect(banner.getByText(FROZEN.rejected)).toBeVisible();

    await banner.getByRole('button', { name: '查看详情' }).click();
    const details = page.getByRole('dialog', { name: '同步被拒绝的内容' });
    await expect(details).toBeVisible();
    await expect(details.getByText('被拒演示任务')).toBeVisible();
    await expect(details.getByText('缺少必填字段')).toBeVisible();
  });

  test('冲突态：「N 条内容与其他设备不一致…」+「查看并处理」入口', async ({ page }) => {
    await stubPush(page, (body) =>
      body.operations.map((operation) => ({
        operationId: operation.operationId,
        status: 'conflict',
        ...CONFLICT_RESULT,
      })),
    );
    await stubPullEmpty(page);
    await gotoInboxWithFailedWrites(page);

    await quickAddTask(page, '冲突演示任务');

    const banner = page.locator(SYNC_BANNER);
    await banner.getByRole('button', { name: SYNC_NOW }).click();

    await expect(banner).toHaveAttribute('data-tone', 'danger');
    await expect(banner.getByText(FROZEN.conflict)).toBeVisible();
    await expect(banner.getByRole('button', { name: '查看并处理' })).toBeVisible();
  });

  test('冲突浮层：三按钮顺序、说明行、初始焦点在取消位', async ({ page }) => {
    await stubPush(page, (body) =>
      body.operations.map((operation) => ({
        operationId: operation.operationId,
        status: 'conflict',
        ...CONFLICT_RESULT,
      })),
    );
    await stubPullEmpty(page);
    await gotoInboxWithFailedWrites(page);

    await quickAddTask(page, '冲突演示任务');
    const banner = page.locator(SYNC_BANNER);
    await banner.getByRole('button', { name: SYNC_NOW }).click();
    await banner.getByRole('button', { name: '查看并处理' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    // 标题：实体名进标题，两个版本并列（§4.9.2 第 2/3 条）。
    await expect(
      page.getByRole('alertdialog', { name: '这条内容有两个版本 · 冲突演示任务' }),
    ).toBeVisible();

    // 说明行：§4.9.2 第 4 条「不可省略、不可弱化」。
    await expect(dialog.getByText('选择后另一版本将被覆盖，此操作不可撤销。')).toBeVisible();

    // 两版摘要：本地这一版仍可见，用户能选择保留它（不静默覆盖本地）。
    await expect(dialog.getByText('此设备的版本')).toBeVisible();
    await expect(dialog.getByText('标题：冲突演示任务')).toBeVisible();
    await expect(dialog.getByText('服务器上的版本')).toBeVisible();
    await expect(dialog.getByText('标题：服务器改过的标题')).toBeVisible();

    // 三按钮左起：低强调「稍后处理」→ secondary「保留服务器版本」→ primary「保留此设备版本」。
    await expect(dialog.getByRole('button')).toHaveText([
      '稍后处理',
      '保留服务器版本',
      '保留此设备版本',
    ]);

    // 初始焦点落在取消位（最安全的退出路径，§4.9.2 第 5 条）。
    await expect(page.locator('[data-confirm-cancel]')).toBeFocused();
  });

  test('Toast 分工：无禁措辞；自动同步成功静默、手动同步成功才提示', async ({ context, page }) => {
    await stubInboxData(page);
    await failTaskCreate(page);
    await page.goto('/inbox');
    await expect(page.getByText('收件箱是空的')).toBeVisible();

    // 先记一条，制造待同步项（同时会有一条「已加入收件箱」Toast，不属禁措辞）。
    await quickAddTask(page, '自动同步静默演示');
    await expect(page.locator(SYNC_BANNER).getByText(FROZEN.pending)).toBeVisible();

    // §4.9.1 明文禁止的两种措辞不得出现。
    await expect(page.getByText('已恢复联网')).toHaveCount(0);
    await expect(page.getByText(/项修改待同步/)).toHaveCount(0);

    // 恢复联网 → `online` 事件触发**自动**同步；这一轮成功必须静默（横幅收起即反馈）。
    let pushRequests = 0;
    await stubPush(page, appliedAll, {
      onRequest: () => {
        pushRequests += 1;
      },
    });
    await stubPullEmpty(page);

    await context.setOffline(true);
    await expect(page.locator(OFFLINE_BANNER)).toBeVisible();
    await context.setOffline(false);

    await expect.poll(() => pushRequests).toBeGreaterThan(0);
    await expect(page.locator(SYNC_BANNER)).toHaveCount(0);
    // 自动同步成功 → 不发「同步完成」。
    await expect(page.getByText('同步完成')).toHaveCount(0);

    // 手动同步成功 → 才提示「同步完成」。
    await quickAddTask(page, '手动同步提示演示');
    await expect(page.locator(SYNC_BANNER).getByText(FROZEN.pending)).toBeVisible();
    await page.locator(SYNC_BANNER).getByRole('button', { name: SYNC_NOW }).click();
    await expect(page.getByText('同步完成')).toBeVisible();

    // 全过程仍无禁措辞。
    await expect(page.getByText('已恢复联网')).toHaveCount(0);
    await expect(page.getByText(/项修改待同步/)).toHaveCount(0);
  });

  test('零新增令牌扫描（静态扫描，非浏览器行为）', () => {
    // 保留 skip：这一项本质是**源码级静态扫描**（确认 SYNC 批次未引入任何新的
    // 设计令牌 / 文案令牌），不是浏览器能观察到的行为。在 Playwright 里用 route
    // 或 DOM 断言"复刻"它，只会得到一个自造的假实现，属虚假覆盖。
    //
    // 诚实的落点是静态层：设计令牌契约由 `tests/unit/shared/ui/tokens.test.ts`
    // （源文件逐项比对 §2.4）与 `tests/e2e/tokens.spec.ts`（浏览器里验令牌真的生效）
    // 共同守护；冻结文案则已由本文件前七条在浏览器里逐字断言。故本项按
    // RD-003/QA-001 的「无法诚实自动化即保留 skip」处理，并另行上报。
    test.skip(true, '零新增令牌是源码级静态扫描，不属于浏览器端 e2e');
  });
});
