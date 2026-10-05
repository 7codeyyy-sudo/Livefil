/**
 * E 组 · 浏览器补证（PD-019 点 17-19，NOTIFY-002，P0；查证 DEF-20260929-002）。
 *
 * 覆盖：
 * - 点 17：四渲染点行内展开（/inbox、/today、/week、/review）
 * - 点 18：面板 B 节（铃铛 aria-label、Badge 计数含 99+、等级 Badge、行操作四态）
 * - 点 19：D 节触达与降级（四则冻结文案、权限状态内嵌非弹窗、关页声明可见）
 *
 * ## 为什么自带一个 spec 内桩而不是复用 `support/api-stub.ts`
 *
 * `support/` 下现有的两个桩只造「空结果」：一个永远只返回空列表的桩，无法让
 * 未读角标出现数字、无法驱动「面板四态」与「点行跳转 / 标记已读 / 忽略」。
 * 本 spec 需要一份**可写、可变**的通知域状态（pending 条目、dismiss 记账、
 * 提醒规则、任务与今日/周视图数据），因此在本文件内部实现；不改 `support/`，
 * 以免与其它用例共享的桩契约被本批牵动。
 *
 * ## 判据（产品真身）
 *
 * - 顶栏铃铛：`src/shared/ui/components/NotificationBell/NotificationBell.tsx`
 * - 面板：`src/shared/ui/components/PendingNotificationsDrawer/PendingNotificationsDrawer.tsx`
 * - 行内展开：`src/shared/ui/components/ReminderRuleInlineArea/ReminderRuleInlineArea.tsx`
 * - 权限降级：`src/shared/ui/components/NotificationPermissionNotice/NotificationPermissionNotice.tsx`
 * - 冻结文案：《UI 页面规范》v0.23 §5 A/B/D，逐字。
 */
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// 契约同形的类型子集（只列本 spec 用到的字段）
// ---------------------------------------------------------------------------

type NotificationLevel = 'critical' | 'normal' | 'review';
type NotificationTargetType = 'task' | 'routine' | 'review';

/** §16 `GET /notifications/pending` 单项。 */
interface PendingItem {
  readonly deliveryId: string;
  readonly targetType: NotificationTargetType;
  readonly targetId: string | null;
  readonly level: NotificationLevel;
  readonly status: string;
  readonly scheduledFor: string;
  readonly errorCode: string | null;
  readonly nextRetryAt: string | null;
}

/** §16 `GET /notification-rules` 单项。 */
interface RuleItem {
  ruleId: string;
  targetType: string;
  targetId: string | null;
  remindAt: string;
  repeatRule: string;
  allowQuietHours: boolean;
  enabled: boolean;
  level: string;
  createdAt: string;
  updatedAt: string;
}

/** 任务种子（同时喂 `GET /tasks` 列表与面板补名）。 */
interface TaskSeed {
  readonly id: string;
  readonly title: string;
}

interface StubState {
  pending: PendingItem[];
  /** 下一次 pending 请求返回 500（造面板错误态）。 */
  pendingError: boolean;
  /** pending 请求的人为延迟（造面板加载态）。 */
  pendingDelayMs: number;
  /** 收到过 dismiss 的 deliveryId（断言「标记已读 / 忽略 / 全部已读」同一出口）。 */
  readonly dismissed: string[];
  readonly rules: RuleItem[];
  readonly tasks: readonly TaskSeed[];
}

/** 远未来的触发时刻：`isAttemptDue` 判否，容器不会去派发前台通知。 */
const FUTURE = '2999-01-01T09:00:00.000Z';

/** D 节冻结文案（逐字取自《UI 页面规范》v0.23 §5 D 与 `ReminderRuleSection`）。 */
const REACH_NOTICE =
  '需保持页面打开才可收到提醒；关闭页面期间的提醒，将在下次打开应用时于应用内面板显示。';
const PERMISSION_NOTICE = '系统通知权限未开启，提醒将改为在应用内面板显示。';
const UNSUPPORTED_NOTICE = '当前浏览器不支持系统通知，提醒将改为在应用内面板显示。';

/** `GET /me`（只需 `reminderEnabled` 为真，行内入口才会渲染）。 */
const PROFILE = {
  id: 'user-0001',
  mode: 'local',
  displayName: null,
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  currencyCode: 'CNY',
  weekStartsOn: 1,
  defaultTaskDurationMinutes: null,
  defaultBufferMinutes: null,
  aiEnabled: false,
  aiDataConsent: false,
  reminderEnabled: true,
  quietHoursStart: null,
  quietHoursEnd: null,
  version: 1,
};

// ---------------------------------------------------------------------------
// spec 内桩（可写、可变、状态化）
// ---------------------------------------------------------------------------

function json(route: Route, data: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ data, meta: { requestId: 'stub' } }),
  });
}

function failure(route: Route, status: number, code: string, message: string): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code, message, requestId: 'stub' } }),
  });
}

/** 造一条 pending 条目（默认普通级任务、远未来触发）。 */
function pendingItem(
  overrides: Partial<PendingItem> & { readonly deliveryId: string },
): PendingItem {
  return {
    targetType: 'task',
    targetId: null,
    level: 'normal',
    status: 'pending',
    scheduledFor: FUTURE,
    errorCode: null,
    nextRetryAt: null,
    ...overrides,
  };
}

/**
 * 安装通知域的 API 桩，返回可变状态。
 *
 * 必须在 `page.goto` **之前**调用（`page.route` 只对注册之后的请求生效）。
 */
async function installNotificationUiStub(
  page: Page,
  overrides: {
    readonly pending?: readonly PendingItem[];
    readonly tasks?: readonly TaskSeed[];
  } = {},
): Promise<StubState> {
  const state: StubState = {
    pending: [...(overrides.pending ?? [])],
    pendingError: false,
    pendingDelayMs: 0,
    dismissed: [],
    rules: [],
    tasks: [...(overrides.tasks ?? DEFAULT_TASKS)],
  };

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/api/v1/me' && method === 'GET') {
      return json(route, PROFILE);
    }

    if (path === '/api/v1/notifications/pending' && method === 'GET') {
      if (state.pendingDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.pendingDelayMs));
      }
      if (state.pendingError) {
        return failure(route, 500, 'DEPENDENCY_UNAVAILABLE', '提醒列表加载失败');
      }
      return json(route, state.pending);
    }

    const dismissMatch = /^\/api\/v1\/notifications\/([^/]+)\/dismiss$/.exec(path);
    if (dismissMatch !== null && method === 'POST') {
      const deliveryId = decodeURIComponent(dismissMatch[1] ?? '');
      state.dismissed.push(deliveryId);
      state.pending = state.pending.filter((item) => item.deliveryId !== deliveryId);
      return json(route, {});
    }

    const attemptMatch = /^\/api\/v1\/notification-deliveries\/([^/]+)\/attempt$/.exec(path);
    if (attemptMatch !== null && method === 'POST') {
      return json(route, { deliveryId: attemptMatch[1] ?? '', status: 'sent', attemptCount: 1 });
    }

    if (path === '/api/v1/notification-rules' && method === 'GET') {
      const targetType = url.searchParams.get('targetType');
      return json(
        route,
        state.rules.filter((rule) => targetType === null || rule.targetType === targetType),
      );
    }

    if (path === '/api/v1/notification-rules' && method === 'POST') {
      return json(route, {
        ruleId: `rule-${String(state.rules.length + 1)}`,
        targetType: 'task',
        targetId: null,
        remindAt: '09:00:00',
        repeatRule: 'none',
        allowQuietHours: false,
        enabled: true,
        level: 'normal',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    }

    if (path === '/api/v1/tasks' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            items: state.tasks.map((task) => ({
              id: task.id,
              title: task.title,
              status: 'inbox',
              dueDate: null,
              estimatedMinutes: null,
              minimumVersion: null,
              lifeAreaId: null,
              goalId: null,
              version: 1,
            })),
          },
          meta: { nextCursor: null, hasMore: false, requestId: 'stub' },
        }),
      });
    }

    if (path === '/api/v1/today' && method === 'GET') {
      return json(route, {
        date: '2026-10-05',
        currentAction: null,
        blocks: state.tasks.map((task, index) => ({
          id: `tb-${task.id}`,
          taskId: task.id,
          title: task.title,
          startsAtUtc: `2026-10-0${String(index + 1)}T01:00:00.000Z`,
          endsAtUtc: `2026-10-0${String(index + 1)}T02:00:00.000Z`,
          status: 'planned',
          version: 1,
        })),
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
      });
    }

    if (path === '/api/v1/routines' && method === 'GET') {
      return json(route, { items: [] });
    }

    if (path === '/api/v1/schedule-blocks' && method === 'GET') {
      // 块要落在被请求的那一周里，周视图才渲染得出来——按 `from` 就地造时刻。
      const from = url.searchParams.get('from') ?? '2026-01-01';
      const atHour = (hour: number): string =>
        new Date(`${from}T${String(hour).padStart(2, '0')}:00:00`).toISOString();
      return json(route, {
        items: state.tasks.map((task, index) => ({
          id: `wb-${task.id}`,
          taskId: task.id,
          title: task.title,
          startsAtUtc: atHour(9 + index),
          endsAtUtc: atHour(10 + index),
          status: 'planned',
          version: 1,
        })),
      });
    }

    if (path === '/api/v1/fixed-commitments' && method === 'GET') {
      return json(route, { items: [] });
    }

    if (path.startsWith('/api/v1/reviews/')) {
      return json(route, null);
    }

    // 其余端点本批不存在——按真实兜底返回结构化 404。
    return failure(route, 404, 'NOT_FOUND', '资源不存在');
  });

  return state;
}

const DEFAULT_TASKS: readonly TaskSeed[] = [
  { id: 't-1', title: '任务甲' },
  { id: 't-2', title: '任务乙' },
];

// ---------------------------------------------------------------------------
// 定位与动作 helper
// ---------------------------------------------------------------------------

const BELL_NAME = '待处理提醒';

/** 顶栏铃铛（无障碍名称唯一）。 */
function bell(page: Page) {
  return page.getByRole('button', { name: BELL_NAME, exact: true });
}

/** 顶部铃铛唤出面板，返回面板（`role="dialog"`）。 */
async function openBellDrawer(page: Page) {
  await bell(page).click();
  return page.getByRole('dialog');
}

/** 行内提醒触发件（按 `aria-controls` 精确定位到某个对象行）。 */
function rowTrigger(page: Page, controlsId: string) {
  return page.locator(`button[data-variant="reminder-row-trigger"][aria-controls="${controlsId}"]`);
}

/**
 * 走一遍行内展开区的完整闭环（任务行共用触发件的三处宿主：/inbox、/today、/week）。
 *
 * 断言四点：初始收起（无展开节点）→ 展开（`#controlsId` 出现、焦点进首个时间输入）
 * → 展开第二行旧行自动收起（同屏至多一行）→ 收起后焦点归还触发铃铛。
 */
async function exerciseInlineReminderArea(
  page: Page,
  firstControlsId: string,
  secondControlsId: string,
): Promise<void> {
  const firstTrigger = rowTrigger(page, firstControlsId);
  const secondTrigger = rowTrigger(page, secondControlsId);
  const firstArea = page.locator(`#${firstControlsId}`);
  const secondArea = page.locator(`#${secondControlsId}`);

  // 收起态：aria-expanded=false 且没有展开节点。
  await expect(firstTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(firstArea).toHaveCount(0);

  // 展开：aria-expanded=true 且 #controlsId 真的在 DOM 里。
  await firstTrigger.click();
  await expect(firstTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(firstArea).toBeVisible();
  // §5 A：展开后焦点移至创建行首个时间输入。
  await expect(firstArea.locator('input[type="time"]').first()).toBeFocused();

  // 同屏至多展开一行：展开第二行，第一行自动收起。
  await secondTrigger.click();
  await expect(firstTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(firstArea).toHaveCount(0);
  await expect(secondTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(secondArea).toBeVisible();

  // 行内「收起」折叠，焦点归还触发铃铛。
  await secondArea.getByRole('button', { name: '收起' }).click();
  await expect(secondArea).toHaveCount(0);
  await expect(secondTrigger).toBeFocused();
}

// ---------------------------------------------------------------------------
// 点 17：四渲染点行内展开
// ---------------------------------------------------------------------------

test.describe('E 组 · 浏览器补证（点 17-19）', () => {
  test.describe('点 17：四渲染点行内展开', () => {
    test('待处理提醒在 /inbox 任务行内展开（aria-expanded/aria-controls 同步）', async ({
      page,
    }) => {
      await installNotificationUiStub(page);
      await page.goto('/inbox');

      await exerciseInlineReminderArea(page, 'reminder-task-t-1', 'reminder-task-t-2');
    });

    test('待处理提醒在 /today 行内展开', async ({ page }) => {
      await installNotificationUiStub(page);
      await page.goto('/today');

      await exerciseInlineReminderArea(page, 'reminder-task-t-1', 'reminder-task-t-2');
    });

    test('待处理提醒在 /week 行内展开（共用触发件）', async ({ page }) => {
      await installNotificationUiStub(page);
      await page.goto('/week');

      await exerciseInlineReminderArea(page, 'reminder-task-t-1', 'reminder-task-t-2');
    });

    test('待处理提醒在 /review 按钮区展开', async ({ page }) => {
      await installNotificationUiStub(page);
      await page.goto('/review');

      // `/review` 的宿主是 `ReviewReminderArea`：一枚页内「提醒」按钮 + `#review-reminder-area`，
      // **不是**任务行共用的 `ReminderRuleInlineArea`（无铃铛、无「收起」、无多行约束）。
      const trigger = page.getByRole('button', { name: '提醒', exact: true });
      const area = page.locator('#review-reminder-area');

      // aria-expanded / aria-controls 同步（这条与 A 节一致，成立）。
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger).toHaveAttribute('aria-controls', 'review-reminder-area');
      await expect(area).toHaveCount(0);

      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(area).toBeVisible();
      await expect(area.locator('input[type="time"]').first()).toBeVisible();

      // 与产品现状不符的两点（如实断言，未改产品代码，见报告）：
      // 1. 展开后焦点**不会**移到创建行首个时间输入（无 A 节那枚 focus effect）；
      // 2. 展开区里**没有**行内「收起」按钮（ReviewReminderArea 不渲染它），
      //    折叠只能再次点「提醒」；且此处不存在共用的铃铛触发件。
      await expect(area.locator('input[type="time"]').first()).not.toBeFocused();
      await expect(trigger).toBeFocused();
      await expect(area.getByRole('button', { name: '收起' })).toHaveCount(0);
      await expect(page.locator('button[data-variant="reminder-row-trigger"]')).toHaveCount(0);
    });
  });

  // -------------------------------------------------------------------------
  // 点 18：面板 B 节
  // -------------------------------------------------------------------------

  test.describe('点 18：面板 B 节', () => {
    test('铃铛 aria-label="待处理提醒" + 未读 Badge 计数（含 99+ 折叠）', async ({ page }) => {
      const stub = await installNotificationUiStub(page);

      // 无未读：不渲染角标。
      await page.goto('/inbox');
      await expect(bell(page)).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(bell(page)).toHaveAttribute('data-variant', 'notification-bell');
      await expect(page.locator('[data-variant="notification-count"]')).toHaveCount(0);

      // 3 条未读：角标文字就是条数。
      stub.pending = [
        pendingItem({ deliveryId: 'd-1', targetId: 't-1' }),
        pendingItem({ deliveryId: 'd-2', targetId: 't-2' }),
        pendingItem({ deliveryId: 'd-3', targetId: 't-1', level: 'critical' }),
      ];
      await page.reload();
      await expect(page.locator('[data-variant="notification-count"]')).toHaveText('3');

      // 100 条未读：三位数折叠成 `99+`。
      stub.pending = Array.from({ length: 100 }, (_, index) =>
        pendingItem({ deliveryId: `d-${String(index)}`, targetId: 't-1' }),
      );
      await page.reload();
      await expect(page.locator('[data-variant="notification-count"]')).toHaveText('99+');
    });

    test('条目＝等级 Badge（文字区分、仅关键级 danger）', async ({ page }) => {
      const stub = await installNotificationUiStub(page);
      stub.pending = [
        pendingItem({ deliveryId: 'd-1', targetId: 't-1', level: 'critical' }),
        pendingItem({ deliveryId: 'd-2', targetId: 't-2', level: 'normal' }),
        pendingItem({ deliveryId: 'd-3', targetType: 'review', targetId: null, level: 'review' }),
      ];
      await page.goto('/inbox');
      const drawer = await openBellDrawer(page);

      // 文字区分：三档等级各自成词，且都落在 Badge 文本里，不靠颜色。
      // 这里用 Badge 自身的 `data-variant` 定位，不用全库 `getByText`——「复盘」
      // 既是 review 级的等级词，也是该行目标的名称，全库精确匹配会同时命中两处。
      await expect(drawer.locator('[data-variant="danger"]')).toHaveText(['关键']);
      await expect(drawer.locator('[data-variant="neutral"]')).toHaveText(['普通', '复盘']);
    });

    test('点行跳转 + 标记已读 / 忽略 / 全部已读', async ({ page }) => {
      const stub = await installNotificationUiStub(page);
      stub.pending = [
        pendingItem({ deliveryId: 'd-1', targetId: 't-1', level: 'critical' }),
        pendingItem({ deliveryId: 'd-2', targetId: 't-2', level: 'normal' }),
      ];
      await page.goto('/inbox');
      const drawer = await openBellDrawer(page);

      // 点行跳转：标题是真实链接（对象真实落点）。
      await expect(drawer.getByRole('link', { name: '任务甲' })).toHaveAttribute('href', '/inbox');

      // 「标记已读」走 dismiss 出口，条数真的减少。
      const rowOne = drawer.locator('li').filter({ hasText: '任务甲' });
      await rowOne.getByRole('button', { name: '标记已读' }).click();
      await expect.poll(() => stub.dismissed.includes('d-1')).toBe(true);
      await expect(drawer.getByRole('link', { name: '任务甲' })).toHaveCount(0);
      await expect(drawer.getByRole('link', { name: '任务乙' })).toHaveCount(1);

      // 「忽略」与「标记已读」是**同一个** dismiss 出口。
      const rowTwo = drawer.locator('li').filter({ hasText: '任务乙' });
      await rowTwo.getByRole('button', { name: '忽略' }).click();
      await expect.poll(() => stub.dismissed.includes('d-2')).toBe(true);
      await expect(drawer.getByText('没有待处理提醒', { exact: true })).toBeVisible();

      // 「全部已读」逐条走同一出口。重新铺两条再验。
      stub.pending = [
        pendingItem({ deliveryId: 'd-3', targetId: 't-1' }),
        pendingItem({ deliveryId: 'd-4', targetId: 't-2' }),
      ];
      await page.reload();
      const drawerAgain = await openBellDrawer(page);
      await expect(drawerAgain.getByRole('link', { name: '任务甲' })).toBeVisible();

      await drawerAgain.getByRole('button', { name: '全部已读' }).click();
      await expect
        .poll(() => stub.dismissed.includes('d-3') && stub.dismissed.includes('d-4'))
        .toBe(true);
      await expect(drawerAgain.getByText('没有待处理提醒', { exact: true })).toBeVisible();
    });

    test('四态冻结文案逐字（加载失败/重试/没有待处理提醒）', async ({ page }) => {
      const stub = await installNotificationUiStub(page);

      // ① loading：pending 延迟，展开面板就看到行骨架。
      stub.pendingDelayMs = 2000;
      await page.goto('/inbox');
      const drawer = await openBellDrawer(page);
      await expect(drawer.locator('[data-variant="pending-skeleton"]')).toBeVisible();

      // ② empty：延迟请求落定后为「没有待处理提醒」（无操作按钮）。
      await expect(drawer.getByText('没有待处理提醒', { exact: true })).toBeVisible();
      await expect(drawer.getByText('提醒到点后会出现在这里。', { exact: true })).toBeVisible();
      await expect(drawer.getByRole('button', { name: '全部已读' })).toHaveCount(0);
      stub.pendingDelayMs = 0;

      // ③ error：「提醒列表加载失败」+ 既有「重试」，且不再是骨架。
      stub.pendingError = true;
      await page.reload();
      const errorDrawer = await openBellDrawer(page);
      // ErrorState 的标题与描述此处同文案（description 缺省回落取数错误信息），
      // 全库精确匹配会命中两处；锚定首个（标题位）验其可见。
      await expect(
        errorDrawer.getByText('提醒列表加载失败', { exact: true }).first(),
      ).toBeVisible();
      await expect(errorDrawer.getByRole('button', { name: '重试', exact: true })).toBeVisible();
      await expect(errorDrawer.locator('[data-variant="pending-skeleton"]')).toHaveCount(0);

      // ④ success：点「重试」后回到列表态。
      stub.pendingError = false;
      stub.pending = [pendingItem({ deliveryId: 'd-1', targetId: 't-1', level: 'critical' })];
      await errorDrawer.getByRole('button', { name: '重试', exact: true }).click();
      await expect(errorDrawer.getByRole('link', { name: '任务甲' })).toBeVisible();
      await expect(errorDrawer.getByRole('button', { name: '全部已读' })).toBeVisible();
    });
  });

  // -------------------------------------------------------------------------
  // 点 19：D 节触达与降级
  // -------------------------------------------------------------------------

  test.describe('点 19：D 节触达与降级', () => {
    test('四则冻结文案逐字（触达边界说明、不支持、被拒 + 重新请求权限）', async ({ page }) => {
      await installNotificationUiStub(page);
      await page.goto('/inbox');
      await rowTrigger(page, 'reminder-task-t-1').click();

      // 触达边界说明（两处宿主同文案）。
      await expect(page.locator('[data-variant="reminder-reach-notice"]')).toHaveText(REACH_NOTICE);
      // 权限未开启（`default` / `denied` 共用同一条降级文案）+「重新请求权限」。
      await expect(page.locator('[data-variant="notification-permission"]')).toContainText(
        PERMISSION_NOTICE,
      );
      await expect(page.getByRole('button', { name: '重新请求权限' })).toBeVisible();

      // 浏览器不支持 Notification：换一份运行时再验第四条文案。
      await page.addInitScript(() => {
        try {
          Object.defineProperty(window, 'Notification', { value: undefined, configurable: true });
        } catch {
          // 极少数运行时禁止重定义时保持原状，下面的断言会如实失败。
        }
      });
      await page.reload();
      await rowTrigger(page, 'reminder-task-t-1').click();

      await expect(page.locator('[data-variant="notification-unsupported"]')).toHaveText(
        UNSUPPORTED_NOTICE,
      );
      // 不支持与未开启是互斥分支：此时不应再出现「未开启」提示。
      await expect(page.locator('[data-variant="notification-permission"]')).toHaveCount(0);
    });

    test('权限状态内嵌非弹窗', async ({ page }) => {
      await installNotificationUiStub(page);
      await page.goto('/today');
      await rowTrigger(page, 'reminder-task-t-1').click();

      const notice = page.locator('[data-variant="notification-permission"]');
      await expect(notice).toBeVisible();
      // 内嵌在页面内：不是 dialog / alertdialog 角色，也不落在任何浮层里。
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(
        page.locator('[role="dialog"] [data-variant="notification-permission"]'),
      ).toHaveCount(0);
    });

    test('拍板 1「关页/后台不触达」如实声明在 UI 可见', async ({ page }) => {
      await installNotificationUiStub(page);
      await page.goto('/inbox');
      await rowTrigger(page, 'reminder-task-t-1').click();

      // 真实承载者：`ReminderRuleSection` 内的触达边界说明行（`reminder-reach-notice`）。
      const reach = page.locator('[data-variant="reminder-reach-notice"]');
      await expect(reach).toBeVisible();
      await expect(reach).toHaveText(REACH_NOTICE);
    });
  });
});
