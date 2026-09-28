/**
 * SYNC-005 局域网复核（测试点 13）。
 *
 * 文件职责：
 * - 先落地四条验收的 Playwright 骨架用例；
 * - 当前环境缺第二设备/手机，**暂不执行**；
 * - 条件具备后，按 §6.3 同机双浏览器 context 实况补跑，并删除本文件开头的 pending 标记。
 *
 * 验收项（来自 RD-20260923-003 §6.3 / PD-20260923-005）：
 * ① PC 创建草稿，另一浏览器可见
 * ② 一端离线创建，恢复网络后另一端可见
 * ③ 同一 operationId 重放 push → already_applied，不二次递增
 * ④ 冲突有明确提示，不静默覆盖
 */
import { test, expect, type Page } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3210';

async function seedTask(page: Page): Promise<string> {
  const response = await page.request.post(`${BASE_URL}/api/v1/tasks`, {
    data: { title: '局域网种子任务', status: 'inbox' },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.data.id).toBeTruthy();
  return body.data.id;
}

/**
 * 模拟离线：拦截全部请求，使 push 超时。
 */
function goOffline(page: Page): void {
  page.route('**/*', (route) => route.abort('timedout'));
}

async function goOnline(page: Page): Promise<void> {
  await page.unroute('**/*');
}

test.describe('SYNC-005 局域网复核（测试点 13）', () => {
  // 条件具备后删除本行，让四条用例真正执行。
  test.skip(true, '缺第二设备/手机，待 B 优先环境就绪后执行');

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    await seedTask(page);
  });

  test('① PC 创建草稿，另一浏览器可见', async () => {
    // TODO: 条件具备后，用第二个 context/browser 复现
    // A context: POST /tasks → 新 id
    // B context: 刷新 → GET /tasks 含新 id
    expect(true).toBe(true);
  });

  test('② 一端离线创建，恢复网络后另一端可见', async ({ page }) => {
    // TODO: A context: 断网 → POST /tasks（入队）→ 恢复联网 → push → 刷新可见
    await goOffline(page);
    // 离线创建
    const createResponse = await page.request.post(`${BASE_URL}/api/v1/tasks`, {});
    expect(createResponse.ok()).toBe(true);
    await goOnline(page);
    expect(true).toBe(true);
  });

  test('③ 同一 operationId 重放 push → already_applied，不二次递增', async () => {
    // TODO: push 同 operationId ×2 → 200 + already_applied，version 不二次递增
    expect(true).toBe(true);
  });

  test('④ 冲突有明确提示，不静默覆盖', async () => {
    // TODO: A 离线改 → B 抢先改 → A push → conflict → 横幅 danger + 浮层三按钮
    expect(true).toBe(true);
  });
});
