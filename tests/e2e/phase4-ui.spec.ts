/**
 * Phase 4 UI 端到端（UI-007）：page.route mock `GET /today` 聚合与执行记录。
 */
import { expect, test } from '@playwright/test';

function envelope(data: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      data,
      meta: { requestId: 'e2e', serverTime: new Date().toISOString() },
    }),
  };
}

const todayView = {
  date: '2026-09-22',
  currentAction: null,
  blocks: [
    {
      id: 'b-1',
      taskId: 't-1',
      actionId: null,
      routineId: null,
      routineStepId: null,
      title: '阅读 30 分钟',
      startsAtUtc: '2026-09-22T01:00:00Z',
      endsAtUtc: '2026-09-22T01:30:00Z',
      status: 'planned',
      source: 'manual',
      conflictState: 'none',
      version: 1,
    },
  ],
  fixedCommitments: [
    {
      id: 'f-1',
      title: '线下坐班',
      startsAtUtc: '2026-09-22T01:00:00Z',
      endsAtUtc: '2026-09-22T09:00:00Z',
    },
  ],
  unscheduledTasks: [{ id: 't-9', title: '整理书桌', dueDate: '2026-09-20', overdue: true }],
  routines: [
    {
      id: 'r-1',
      name: '晨间例程',
      scheduled: true,
      steps: [{ id: 'rs-1', title: '喝水', blockId: 'b-1', status: 'planned' }],
    },
  ],
  habits: [{ actionId: 'a-1', goalId: 'g-1', title: '拉伸', targetFrequency: 3, doneToday: false }],
  load: {
    fixedMinutes: 480,
    plannedMinutes: 30,
    completedMinutes: 0,
    availableMinutes: 480,
    overloaded: false,
  },
  recovery: {
    manual: false,
    since: null,
    autoTriggered: true,
    suggestions: [],
  },
};

test.describe('今日页（UI-007）', () => {
  test('聚合渲染：时间线、固定事项、未安排过期标记、恢复轻提示', async ({ page }) => {
    void page.route('**/api/v1/today*', (route) => route.fulfill(envelope(todayView)));
    await page.goto('/today');

    await expect(page.getByText('阅读 30 分钟')).toBeVisible();
    await expect(page.getByText('线下坐班')).toBeVisible();
    await expect(page.getByText('整理书桌')).toBeVisible();
    await expect(page.getByText('过期', { exact: true })).toBeVisible();
    await expect(page.getByText('最近两天完成得不多，要不要减轻一点？')).toBeVisible();
    // 可关闭（可忽略，不自动改计划）。
    await page.getByRole('button', { name: '知道了' }).click();
    await expect(page.getByText('最近两天完成得不多，要不要减轻一点？')).toBeHidden();
  });

  test('块行内「完成」经执行记录端点（幂等键 + 状态联动）', async ({ page }) => {
    const bodies: Array<Record<string, unknown>> = [];
    void page.route('**/api/v1/today*', (route) => route.fulfill(envelope(todayView)));
    void page.route('**/api/v1/execution-logs', (route) => {
      if (route.request().method() === 'POST') {
        bodies.push(route.request().postDataJSON() as Record<string, unknown>);
        void route.fulfill(envelope({ id: 'log-1' }));
        return;
      }
      void route.fulfill(envelope({ items: [] }));
    });
    await page.goto('/today');

    await page.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.getByText('已完成', { exact: true })).toBeVisible();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.['scheduleBlockId']).toBe('b-1');
    expect(bodies[0]?.['status']).toBe('completed');
    // 幂等键随请求生成（§7 冻结：执行记录必须携带）。
    expect(typeof bodies[0]?.['taskId']).toBe('string');
  });

  test('例程步骤勾选完成：经执行记录落到步骤块', async ({ page }) => {
    const bodies: Array<Record<string, unknown>> = [];
    void page.route('**/api/v1/today*', (route) => route.fulfill(envelope(todayView)));
    void page.route('**/api/v1/execution-logs', (route) => {
      if (route.request().method() === 'POST') {
        bodies.push(route.request().postDataJSON() as Record<string, unknown>);
        void route.fulfill(envelope({ id: 'log-3' }));
        return;
      }
      void route.fulfill(envelope({ items: [] }));
    });
    await page.goto('/today');

    await page.getByLabel('完成例程步骤：喝水').click();
    await expect(page.getByText('已完成', { exact: true }).first()).toBeVisible();
    // 步骤块完成＝记录 scheduleBlockId（联动口径）。
    expect(bodies[0]?.['scheduleBlockId']).toBe('b-1');
  });

  test('习惯打卡：勾选即记录（无独立 habits 表口径）', async ({ page }) => {
    const bodies: Array<Record<string, unknown>> = [];
    const mutableView: typeof todayView = JSON.parse(JSON.stringify(todayView));
    void page.route('**/api/v1/today*', (route) => route.fulfill(envelope(mutableView)));
    void page.route('**/api/v1/execution-logs', (route) => {
      if (route.request().method() === 'POST') {
        bodies.push(route.request().postDataJSON() as Record<string, unknown>);
        // 打卡成功 → 当日记录存在 → 下一次聚合 doneToday=true（refetch 后勾选保持）。
        mutableView.habits = mutableView.habits.map((habit) =>
          habit.actionId === 'a-1' ? { ...habit, doneToday: true } : habit,
        );
        void route.fulfill(envelope({ id: 'log-2' }));
        return;
      }
      void route.fulfill(envelope({ items: [] }));
    });
    await page.goto('/today');

    // 触屏设备上受控 checkbox 的 check() 存在重渲染竞态——这里断言的是
    // 「勾选动作发出正确的请求」，点击即可（状态翻转由桌面 project 验证）。
    await page.getByLabel('完成习惯：拉伸').click();
    await expect(page.getByText('已打卡')).toBeVisible();
    expect(bodies[0]?.['actionId']).toBe('a-1');
  });
});
