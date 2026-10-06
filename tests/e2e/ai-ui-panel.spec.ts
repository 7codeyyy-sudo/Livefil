/**
 * Phase 9 · AI 智能向导与建议——UI 与客户端纪律补证
 * （QA-20260929-004 点 10–15 + 护栏 2 / 护栏 7 / 护栏 3-UI 半边 / 护栏 8）。
 *
 * 覆盖：
 * - 点 14：AI 关闭态（`ai_enabled=false`）四入口在四页均不渲染；`GET /me` 失败
 *   （开关未知，`useAiEnabled()` 返 `null`）同样不渲染；且关闭不使页面变空白。
 * - 点 10：A 引导四步——可推进（逐级）、可跳过、可重开、可关闭。
 * - 点 15：三句空结果冻结文案逐字（C1 / C2 / D）。
 * - 点 11：B 上下文帮助入口在四个 AI 页均可及，且不随 AI 开关隐藏。
 * - 点 12：C 组确认界面三形态齐备（拆分 Drawer / 排程建议区 / 记账解析区）。
 * - 点 13：D 周摘要固定空态句 + 实时请求 / 骨架 / 就绪 / 降级的分层呈现。
 * - 护栏 2：同意弹层只在首次出现，同意后跨页不再弹；取消不发任何 AI 请求。
 * - 护栏 7：C3 未识别金额冻结文案 + 不提供可点的「确认记账」。
 * - 护栏 3（UI 半边）：C1 清空标题即禁用「确认创建」并就地提示「请填写任务标题」。
 * - 护栏 8：C2 逐条接受（Toast 带「撤销」）/ 撤销（发 DELETE）/ 拒绝不落库。
 *
 * ## 为什么自带一个 spec 内桩而不是复用 `support/api-stub.ts`
 *
 * 本批要驱动的是**可变的 AI 域状态**：四类草稿的三种结局（ok / 空结果 / provider
 * 故障）、引导四步的四根判定旗标（目标行动、时间块、执行记录、当日复盘）、以及
 * 「写没写库」的副作用（`POST` / `DELETE /schedule-blocks` 的记账）。`support/`
 * 下的桩只造空结果，无法表达这些；因此在本文件内部实现，不改 `support/`，以免与
 * 其它用例共享的桩契约被本批牵动（范式与 `notifications-ui-panel.spec.ts` 同源）。
 *
 * ## 判据（产品真身）
 *
 * - 开关唯一判定源：`app/(app)/_lib/use-ai-enabled.ts`（`GET /me` 的 `aiEnabled`）
 * - 四入口：`InboxPanel`（C1）/ `WeekPanel`（C2）/ `ExpenseFormDrawer` +`ExpenseAiParseArea`（C3）
 *   / `WeeklyReviewSection` + `WeeklyAiSummarySection`（D）
 * - 同意层：`app/(app)/_lib/ai-consent.ts`（sessionStorage `livefil.ai-consent.v1`）
 * - 引导：`guide-steps.ts` + `GuideBarContainer` + `GuideProvider` + `GuideBar`
 * - 帮助：`HelpDrawerContainer` + `help-content.ts` + `HelpDrawer`
 * - 冻结文案：各组件内命名常量，本文件逐字复制（不使用转述）。
 */
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// 契约同形的类型子集与常量
// ---------------------------------------------------------------------------

type DraftOutcome = 'ok' | 'empty' | 'error';
type ExpenseOutcome = 'ok' | 'unrecognized' | 'error';

/** 一次被观察到的写请求（方法与路径）。 */
interface CapturedRequest {
  readonly method: string;
  readonly url: string;
}

/** 引导四步各自的判定旗标（对应四个既有端点的"事实存在吗"）。 */
interface GuideFlags {
  goalHasAction: boolean;
  hasBlock: boolean;
  hasExecutionLog: boolean;
  hasDailyReview: boolean;
}

interface TaskSeed {
  readonly id: string;
  readonly title: string;
}

interface GoalSeed {
  readonly id: string;
  readonly name: string;
}

interface StubState {
  aiEnabled: boolean;
  /** `GET /me` 返 500（开关未知态）。 */
  meFails: boolean;
  guide: GuideFlags;
  breakdownOutcome: DraftOutcome;
  scheduleOutcome: DraftOutcome;
  expenseOutcome: ExpenseOutcome;
  reviewOutcome: DraftOutcome;
  /** AI 请求的人为延迟（造骨架态）。 */
  aiDelayMs: number;
  /** 收到的全部 `/api/v1/ai/**` 请求（护栏 2 的零请求证据）。 */
  readonly aiRequests: CapturedRequest[];
  /** confirm 端点被调用的次数（点 12 的"确认前零写入"证据）。 */
  aiConfirmCount: number;
  /** `POST /schedule-blocks` 记账（护栏 8）。 */
  readonly blockWrites: CapturedRequest[];
  /** `DELETE /schedule-blocks/{id}` 记账（护栏 8）。 */
  readonly blockDeletes: CapturedRequest[];
  readonly tasks: readonly TaskSeed[];
  readonly goals: readonly GoalSeed[];
}

/** 远未来时刻（草稿有效期用；`Date.parse` 得到正数，不会立刻过期）。 */
const FUTURE = '2999-01-01T00:00:00.000Z';

/** `GET /me`（`aiEnabled` 由桩状态注入）。 */
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
  aiEnabled: true,
  aiDataConsent: true,
  reminderEnabled: true,
  quietHoursStart: null,
  quietHoursEnd: null,
  version: 1,
};

const DEFAULT_TASKS: readonly TaskSeed[] = [
  { id: 't-1', title: '任务甲' },
  { id: 't-2', title: '任务乙' },
];

const DEFAULT_GOALS: readonly GoalSeed[] = [{ id: 'g-1', name: '目标甲' }];

const DEFAULT_CATEGORIES = [
  { id: 'c-1', name: '餐饮', sortOrder: 1, isDefault: true, isArchived: false, version: 1 },
];

/** C4 数据范围行（逐字取 `AiScopeNotice` 的冻结句式 + 各入口的 `SCOPE_TEXT`）。 */
const SCOPE_BREAKDOWN =
  '本次将发送给 AI：你输入的这段描述。AI 不读取你的完整历史记录；结果为草稿，确认后才写入。';
const SCOPE_SCHEDULE =
  '本次将发送给 AI：你所选的任务与可用时间。AI 不读取你的完整历史记录；结果为草稿，确认后才写入。';
const SCOPE_EXPENSE =
  '本次将发送给 AI：你粘贴的这段文本。AI 不读取你的完整历史记录；结果为草稿，确认后才写入。';
const SCOPE_REVIEW =
  '本次将发送给 AI：你勾选的这几类本周数据。AI 不读取你的完整历史记录；结果为草稿，确认后才写入。';

/** 冻结文案（逐字取自各组件内命名常量）。 */
const EMPTY_BREAKDOWN = '这次没拆出可用的任务。你可以手动新建，或重新生成。';
const EMPTY_SCHEDULE = '这次没给出建议。你可以手动安排，或重新生成。';
const EMPTY_REVIEW_RESULT = '这次没生成摘要。你可以手填本周复盘，或重新生成。';
const WEEKLY_IDLE_TEXT = '本周摘要在你选择数据后生成，不会自动运行。';
const FORBIDDEN_LINE = 'AI建议仅供参考，不提供医疗、心理、投资或借贷判断。';
const AMOUNT_NOT_RECOGNIZED = '未识别出金额，请手动填写。';
const AI_UNAVAILABLE_TEXT = 'AI 暂不可用，已为你保留手动流程。';

/** 引导四步卡文与主操作（逐字取自 `guide-steps.ts`）。 */
const GUIDE_STEPS_TEXT: readonly {
  readonly card: string;
  readonly action: string;
  readonly href: string;
}[] = [
  { card: '写下你要做的第一件事', action: '去创建', href: '/goals' },
  { card: '把第一步放进时间线', action: '去安排', href: '/week' },
  { card: '完成一件，记录一次', action: '去完成', href: '/today' },
  { card: '回答三问，完成第一次复盘', action: '去复盘', href: '/review' },
];

/** 帮助抽屉「当前页下一步」（逐字取自 `help-content.ts`；`/week` 命中中性兜底）。 */
const NEXT_STEP_BY_ROUTE: readonly { readonly path: string; readonly next: string }[] = [
  { path: '/inbox', next: '快速记下一件事，稍后再整理。' },
  { path: '/week', next: '这一页没有额外的下一步提示，可以从顶栏去别的页面继续。' },
  { path: '/expenses', next: '记下第一笔开销。' },
  { path: '/review', next: '回答三问中的任意一题，完成今天的复盘。' },
];

/** 本地日历日（与 `queries.ts` 的 `localCalendarDate` 同口径）。 */
function localCalendarDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 空周复盘（B2 七项全零，四态计数恒存在）。 */
function weeklyReviewItem(): Record<string, unknown> {
  return {
    weekStart: '2026-01-05',
    planActual: { plannedMinutes: 0, actualMinutes: 0 },
    taskStatusCounts: { completed: 0, partial: 0, deferred: 0, skipped: 0 },
    repeatedDeferrals: [],
    goalActions: [],
    expenseSummaries: [],
    adjustments: [],
    snapshotSchemaVersion: null,
  };
}

function dailyReviewItem(): Record<string, unknown> {
  return {
    date: localCalendarDate(),
    answers: null,
    energyLevel: null,
    version: null,
    createdAt: null,
    facts: { plannedMinutes: 0, actualMinutes: 0, completedCount: 0, uncompletedCount: 0 },
  };
}

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

/** 四类草稿生成端点的响应（按 `outcome` 分三态：ok / 空结果 / provider 故障）。 */
function aiDraftResponse(route: Route, state: StubState, path: string): Promise<void> {
  if (path === '/api/v1/ai/drafts/task-breakdown') {
    if (state.breakdownOutcome === 'error') {
      return failure(route, 504, 'AI_UNAVAILABLE', 'AI 服务暂时不可用');
    }
    if (state.breakdownOutcome === 'empty') {
      return json(route, {
        draftId: 'd-bd',
        type: 'task_breakdown',
        status: 'failed',
        suggestions: [],
        expiresAt: FUTURE,
      });
    }
    return json(route, {
      draftId: 'd-bd',
      type: 'task_breakdown',
      status: 'pending',
      suggestions: [
        { title: '建议甲', estimatedMinutes: 30 },
        { title: '建议乙', estimatedMinutes: 20 },
      ],
      expiresAt: FUTURE,
    });
  }

  if (path === '/api/v1/ai/drafts/schedule-suggestion') {
    if (state.scheduleOutcome === 'error') {
      return failure(route, 504, 'AI_UNAVAILABLE', 'AI 服务暂时不可用');
    }
    if (state.scheduleOutcome === 'empty') {
      return json(route, {
        draftId: 'd-sch',
        type: 'schedule_suggestion',
        status: 'failed',
        suggestions: [],
        expiresAt: FUTURE,
      });
    }
    return json(route, {
      draftId: 'd-sch',
      type: 'schedule_suggestion',
      status: 'pending',
      suggestions: [
        {
          taskId: 't-1',
          blockStart: '2026-10-06T09:00:00.000Z',
          blockEnd: '2026-10-06T10:00:00.000Z',
          reason: '上午精力更好',
        },
      ],
      expiresAt: FUTURE,
    });
  }

  if (path === '/api/v1/ai/drafts/expense-parse') {
    if (state.expenseOutcome === 'error') {
      return failure(route, 504, 'AI_UNAVAILABLE', 'AI 服务暂时不可用');
    }
    if (state.expenseOutcome === 'unrecognized') {
      return json(route, {
        draftId: 'd-exp',
        type: 'expense_parse',
        status: 'failed',
        draft: null,
        expiresAt: FUTURE,
      });
    }
    return json(route, {
      draftId: 'd-exp',
      type: 'expense_parse',
      status: 'pending',
      draft: {
        amountMinor: 3500,
        currencyCode: 'CNY',
        occurredOn: localCalendarDate(),
        categoryId: 'c-1',
        note: '午饭',
      },
      expiresAt: FUTURE,
    });
  }

  if (path === '/api/v1/ai/drafts/review-summary') {
    if (state.reviewOutcome === 'error') {
      return failure(route, 504, 'AI_UNAVAILABLE', 'AI 服务暂时不可用');
    }
    if (state.reviewOutcome === 'empty') {
      return json(route, {
        draftId: 'd-rev',
        type: 'review_summary',
        status: 'failed',
        summary: { highlights: [], suggestions: [] },
        expiresAt: FUTURE,
      });
    }
    return json(route, {
      draftId: 'd-rev',
      type: 'review_summary',
      status: 'pending',
      summary: {
        highlights: ['本周计划执行稳定。'],
        suggestions: ['下周可减少一次延期。'],
      },
      expiresAt: FUTURE,
    });
  }

  if (path === '/api/v1/ai/usage') {
    return json(route, {
      periodStart: '2026-10-01',
      resetAt: FUTURE,
      callCount: 0,
      costMinor: 0,
      callLimit: 100,
      costLimitMinor: 10000,
      remainingCalls: 100,
      remainingCostMinor: 10000,
    });
  }

  return failure(route, 404, 'NOT_FOUND', '资源不存在');
}

/**
 * 安装 AI 向导域的 API 桩，返回可变状态。
 *
 * 必须在 `page.goto` **之前**调用（`page.route` 只对注册之后的请求生效）。
 */
async function installAiWizardStub(page: Page): Promise<StubState> {
  const state: StubState = {
    aiEnabled: true,
    meFails: false,
    guide: {
      goalHasAction: false,
      hasBlock: false,
      hasExecutionLog: false,
      hasDailyReview: false,
    },
    breakdownOutcome: 'ok',
    scheduleOutcome: 'ok',
    expenseOutcome: 'ok',
    reviewOutcome: 'ok',
    aiDelayMs: 0,
    aiRequests: [],
    aiConfirmCount: 0,
    blockWrites: [],
    blockDeletes: [],
    tasks: [...DEFAULT_TASKS],
    goals: [...DEFAULT_GOALS],
  };

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path.startsWith('/api/v1/ai/')) {
      state.aiRequests.push({ method, url: path });
      if (state.aiDelayMs > 0) {
        await sleep(state.aiDelayMs);
      }
      if (/^\/api\/v1\/ai\/drafts\/[^/]+\/confirm$/.test(path) && method === 'POST') {
        state.aiConfirmCount += 1;
        return json(route, {
          draftId: 'd-1',
          type: 'task_breakdown',
          status: 'confirmed',
          createdIds: ['t-n1', 't-n2'],
        });
      }
      if (/^\/api\/v1\/ai\/drafts\/[^/]+\/cancel$/.test(path) && method === 'POST') {
        return json(route, { draftId: 'd-1', type: 'task_breakdown', status: 'cancelled' });
      }
      return aiDraftResponse(route, state, path);
    }

    if (path === '/api/v1/me' && method === 'GET') {
      if (state.meFails) {
        return failure(route, 500, 'INTERNAL_ERROR', '服务内部错误');
      }
      return json(route, { ...PROFILE, aiEnabled: state.aiEnabled });
    }

    if (path === '/api/v1/notifications/pending' && method === 'GET') {
      return json(route, []);
    }

    if (path === '/api/v1/notification-rules' && method === 'GET') {
      return json(route, []);
    }

    if (path === '/api/v1/tasks' && method === 'GET') {
      // 游标分页：收件箱与「排程候选」都读 `data.items` + `meta.nextCursor/hasMore`。
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

    if (path === '/api/v1/goals' && method === 'GET') {
      return json(route, { items: state.goals });
    }

    const goalMatch = /^\/api\/v1\/goals\/([^/]+)$/.exec(path);
    if (goalMatch !== null && method === 'GET') {
      const goal = state.goals.find((item) => item.id === (goalMatch[1] ?? '')) ?? DEFAULT_GOALS[0];
      return json(route, {
        goal: {
          id: goal?.id ?? 'g-1',
          name: goal?.name ?? '目标甲',
          status: 'active',
          targetDate: null,
          resultMetric: null,
          version: 1,
        },
        // 引导步 1 的判定只读 `actions.length`。
        actions: state.guide.goalHasAction
          ? [{ id: 'a-1', name: '行动甲', status: 'active', estimatedMinutes: null }]
          : [],
        actionProgress: { total: 0, completed: 0, active: 0, paused: 0 },
        expenses: [],
      });
    }

    if (path === '/api/v1/schedule-blocks' && method === 'GET') {
      // 引导步 2 与周视图共用同一端点：旗标控制"有没有时间块"。
      return json(route, {
        items: state.guide.hasBlock
          ? [
              {
                id: 'gb-1',
                taskId: 't-1',
                title: '任务甲',
                startsAtUtc: '2026-10-06T09:00:00.000Z',
                endsAtUtc: '2026-10-06T10:00:00.000Z',
                status: 'planned',
                version: 1,
              },
            ]
          : [],
      });
    }

    if (path === '/api/v1/schedule-blocks' && method === 'POST') {
      state.blockWrites.push({ method, url: path });
      return json(route, { id: 'sb-new-1', version: 1 });
    }

    const blockDeleteMatch = /^\/api\/v1\/schedule-blocks\/([^/]+)$/.exec(path);
    if (blockDeleteMatch !== null && method === 'DELETE') {
      state.blockDeletes.push({ method, url: path });
      return json(route, { id: blockDeleteMatch[1] ?? 'sb-new-1', deletedAt: FUTURE, version: 2 });
    }

    if (path === '/api/v1/fixed-commitments' && method === 'GET') {
      return json(route, { items: [] });
    }

    if (path === '/api/v1/routines' && method === 'GET') {
      return json(route, { items: [] });
    }

    if (path === '/api/v1/execution-logs' && method === 'GET') {
      // 引导步 3 的判定只读 `items.length`。
      return json(route, { items: state.guide.hasExecutionLog ? [{ id: 'el-1' }] : [] });
    }

    if (path === '/api/v1/today' && method === 'GET') {
      return json(route, {
        date: localCalendarDate(),
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
      });
    }

    if (path === '/api/v1/expenses' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { items: [] },
          meta: { nextCursor: null, hasMore: false, requestId: 'stub' },
        }),
      });
    }

    if (path === '/api/v1/expense-categories' && method === 'GET') {
      return json(route, { items: DEFAULT_CATEGORIES });
    }

    if (path === '/api/v1/life-areas' && method === 'GET') {
      return json(route, { items: [] });
    }

    if (path === '/api/v1/expense-summary' && method === 'GET') {
      return json(route, { groups: [], grandTotals: [] });
    }

    if (/^\/api\/v1\/reviews\/weekly\/[^/]+$/.test(path) && method === 'GET') {
      return json(route, weeklyReviewItem());
    }

    if (/^\/api\/v1\/reviews\/daily\/[^/]+$/.test(path) && method === 'GET') {
      // 引导步 4 的判定读 `data !== null`。
      return json(route, state.guide.hasDailyReview ? dailyReviewItem() : null);
    }

    return failure(route, 404, 'NOT_FOUND', '资源不存在');
  });

  return state;
}

/**
 * 预置「本会话已同意」——写 sessionStorage（`ai-consent.ts` 的存储键）。
 *
 * 点 12/13/15 与护栏 3/7/8 都只需验证 AI 交互本身，用它在 `page.goto` 前跳过
 * 一次性同意弹层；护栏 2 刻意**不**调用它，走完整同意流程。
 */
async function grantConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.sessionStorage.setItem('livefil.ai-consent.v1', '1');
    } catch {
      // 隐私模式存不下：本用例只关心跳过弹层，存不下会如实让断言失败。
    }
  });
}

// ---------------------------------------------------------------------------
// 定位与动作 helper
// ---------------------------------------------------------------------------

function guideBar(page: Page) {
  return page.locator('section[data-variant="guide-bar"]');
}

function helpEntry(page: Page) {
  return page.getByRole('button', { name: '帮助与引导', exact: true });
}

function helpDrawer(page: Page) {
  return page.getByRole('dialog', { name: '帮助与引导' });
}

/** 打开顶栏帮助抽屉并断言可见。 */
async function openHelpDrawer(page: Page): Promise<void> {
  await helpEntry(page).click();
  const drawer = helpDrawer(page);
  await expect(drawer).toBeVisible();
}

/** 点抽屉右上角的「关闭」（`exact` 避开提示条的「关闭提示」）。 */
async function closeDialog(dialog: ReturnType<Page['getByRole']>): Promise<void> {
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
}

/** 进入 `/review` 的「周复盘」分段（AI 摘要区的宿主）。 */
async function gotoWeeklyReview(page: Page): Promise<void> {
  await page.goto('/review');
  const weeklyTab = page.getByRole('button', { name: '周复盘', exact: true });
  await weeklyTab.click();
  await expect(weeklyTab).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('section[aria-label="AI 摘要"]')).toBeVisible();
}

/** 逐一走四页，断言该页的 AI 入口一个都不渲染。 */
async function expectNoAiEntries(page: Page): Promise<void> {
  await page.goto('/inbox');
  await expect(page.getByRole('button', { name: '拆分任务', exact: true })).toHaveCount(0);

  await page.goto('/week');
  await expect(page.locator('section[aria-label="排程建议"]')).toHaveCount(0);

  await page.goto('/expenses');
  await page.getByRole('button', { name: '记一笔', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: '记一笔' })).toBeVisible();
  await expect(page.getByRole('button', { name: '粘贴文本记一笔', exact: true })).toHaveCount(0);

  await page.goto('/review');
  const weeklyTab = page.getByRole('button', { name: '周复盘', exact: true });
  await weeklyTab.click();
  await expect(weeklyTab).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('section[aria-label="AI 摘要"]')).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// 点 14：AI 关闭态四入口不渲染（Gate D 判据）
// ---------------------------------------------------------------------------

test.describe('Phase 9 · AI 向导与建议（QA-004 点 10–15 + 护栏）', () => {
  test.describe('点 14：AI 关闭态四入口不渲染', () => {
    test('aiEnabled=false 时四入口在四页均不出现', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      stub.aiEnabled = false;

      await expectNoAiEntries(page);
    });

    test('GET /me 失败（开关未知）时四入口同样不渲染', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      stub.meFails = true;

      await expectNoAiEntries(page);
    });

    test('AI 关闭不使页面变空白（收件箱列表与记账表单仍可用）', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      stub.aiEnabled = false;

      await page.goto('/inbox');
      await expect(page.getByText('任务甲', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '添加', exact: true })).toBeVisible();

      await page.goto('/expenses');
      await page.getByRole('button', { name: '记一笔', exact: true }).first().click();
      const drawer = page.getByRole('dialog', { name: '记一笔' });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByLabel('金额（必填）')).toBeVisible();
      await expect(drawer.getByLabel('日期（必填）')).toBeVisible();
    });
  });

  // -------------------------------------------------------------------------
  // 点 10：A 引导四步
  // -------------------------------------------------------------------------

  test.describe('点 10：A 引导四步', () => {
    test('四步可逐级推进，走完后引导条自动隐藏', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      await page.goto('/today');

      await expect(guideBar(page)).toBeVisible();
      await expect(guideBar(page).getByText('第 1 / 4 步', { exact: true })).toBeVisible();
      await expect(
        guideBar(page).getByText(GUIDE_STEPS_TEXT[0]?.card ?? '', { exact: true }),
      ).toBeVisible();
      await expect(
        guideBar(page).getByRole('link', { name: '去创建', exact: true }),
      ).toHaveAttribute('href', '/goals');

      stub.guide.goalHasAction = true;
      await page.reload();
      await expect(guideBar(page).getByText('第 2 / 4 步', { exact: true })).toBeVisible();
      await expect(
        guideBar(page).getByText(GUIDE_STEPS_TEXT[1]?.card ?? '', { exact: true }),
      ).toBeVisible();
      await expect(
        guideBar(page).getByRole('link', { name: '去安排', exact: true }),
      ).toHaveAttribute('href', '/week');

      stub.guide.hasBlock = true;
      await page.reload();
      await expect(guideBar(page).getByText('第 3 / 4 步', { exact: true })).toBeVisible();
      await expect(
        guideBar(page).getByText(GUIDE_STEPS_TEXT[2]?.card ?? '', { exact: true }),
      ).toBeVisible();
      await expect(
        guideBar(page).getByRole('link', { name: '去完成', exact: true }),
      ).toHaveAttribute('href', '/today');

      stub.guide.hasExecutionLog = true;
      await page.reload();
      await expect(guideBar(page).getByText('第 4 / 4 步', { exact: true })).toBeVisible();
      await expect(
        guideBar(page).getByText(GUIDE_STEPS_TEXT[3]?.card ?? '', { exact: true }),
      ).toBeVisible();
      await expect(
        guideBar(page).getByRole('link', { name: '去复盘', exact: true }),
      ).toHaveAttribute('href', '/review');

      stub.guide.hasDailyReview = true;
      await page.reload();
      await expect(guideBar(page)).toHaveCount(0);
    });

    test('可跳过：隐藏后刷新仍隐藏，进度保留在第 1 步', async ({ page }) => {
      await installAiWizardStub(page);
      await page.goto('/today');
      await expect(guideBar(page)).toBeVisible();

      await guideBar(page).getByRole('button', { name: '跳过', exact: true }).click();
      await expect(guideBar(page)).toHaveCount(0);

      await page.reload();
      await expect(guideBar(page)).toHaveCount(0);

      await openHelpDrawer(page);
      await expect(helpDrawer(page).locator('section[aria-label="新手引导"]')).toContainText(
        '第 1 / 4 步',
      );
    });

    test('可关闭（×）：隐藏后刷新仍隐藏', async ({ page }) => {
      await installAiWizardStub(page);
      await page.goto('/today');
      await expect(guideBar(page)).toBeVisible();

      await guideBar(page).getByRole('button', { name: '关闭新手引导', exact: true }).click();
      await expect(guideBar(page)).toHaveCount(0);

      await page.reload();
      await expect(guideBar(page)).toHaveCount(0);
    });

    test('可重开：帮助抽屉「重新查看新手引导」唤回引导条', async ({ page }) => {
      await installAiWizardStub(page);
      await page.goto('/today');
      await expect(guideBar(page)).toBeVisible();

      await guideBar(page).getByRole('button', { name: '关闭新手引导', exact: true }).click();
      await expect(guideBar(page)).toHaveCount(0);

      await openHelpDrawer(page);
      await helpDrawer(page).getByRole('button', { name: '重新查看新手引导', exact: true }).click();
      await expect(helpDrawer(page)).toHaveCount(0);
      await expect(guideBar(page)).toBeVisible();
      await expect(guideBar(page).getByText('第 1 / 4 步', { exact: true })).toBeVisible();
    });
  });

  // -------------------------------------------------------------------------
  // 点 15：三句空结果冻结文案逐字
  // -------------------------------------------------------------------------

  test.describe('点 15：空结果冻结文案逐字', () => {
    test('C1 拆分任务：空结果句 + 重新生成，且不出「AI 暂不可用」', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      await grantConsent(page);
      stub.breakdownOutcome = 'empty';

      await page.goto('/inbox');
      await page.getByLabel('快速添加任务').fill('整理书桌');
      await page.getByRole('button', { name: '拆分任务', exact: true }).click();

      const drawer = page.getByRole('dialog', { name: '拆分任务' });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByText(EMPTY_BREAKDOWN, { exact: true })).toBeVisible();
      await expect(drawer.getByRole('button', { name: '重新生成', exact: true })).toBeVisible();
      await expect(drawer.locator('[data-variant="ai-unavailable"]')).toHaveCount(0);
    });

    test('C2 排程建议：空结果句 + 重新生成 / 手动安排', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      await grantConsent(page);
      stub.scheduleOutcome = 'empty';

      await page.goto('/week');
      await page.getByRole('checkbox', { name: '选择任务：任务甲' }).check();
      await page.getByRole('button', { name: '安排时间', exact: true }).click();

      const section = page.locator('section[aria-label="排程建议"]');
      await expect(section.getByText(EMPTY_SCHEDULE, { exact: true })).toBeVisible();
      await expect(section.getByRole('button', { name: '重新生成', exact: true })).toBeVisible();
      await expect(section.getByRole('button', { name: '手动安排', exact: true })).toBeVisible();
      await expect(section.locator('[data-variant="ai-unavailable"]')).toHaveCount(0);
    });

    test('D 周摘要：空结果句 + 重新生成', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      await grantConsent(page);
      stub.reviewOutcome = 'empty';

      await gotoWeeklyReview(page);
      const section = page.locator('section[aria-label="AI 摘要"]');
      await section.getByRole('button', { name: '生成本周摘要', exact: true }).click();
      await section.getByRole('button', { name: '生成本周摘要', exact: true }).click();

      await expect(section.getByText(EMPTY_REVIEW_RESULT, { exact: true })).toBeVisible();
      await expect(section.getByRole('button', { name: '重新生成', exact: true })).toBeVisible();
      await expect(section.locator('[data-variant="ai-unavailable"]')).toHaveCount(0);
    });
  });

  // -------------------------------------------------------------------------
  // 点 11：B 上下文帮助入口
  // -------------------------------------------------------------------------

  test.describe('点 11：B 上下文帮助入口', () => {
    test('四页帮助入口可及，并给出各页「当前页下一步」', async ({ page }) => {
      await installAiWizardStub(page);

      for (const item of NEXT_STEP_BY_ROUTE) {
        await page.goto(item.path);
        await expect(helpEntry(page)).toBeVisible();

        await openHelpDrawer(page);
        const drawer = helpDrawer(page);
        await expect(drawer.locator('section[aria-label="当前页下一步"] p')).toHaveText(item.next);
        await expect(drawer.locator('section[aria-label="新手引导"]')).toBeVisible();

        await closeDialog(drawer);
        await expect(drawer).toHaveCount(0);
      }
    });

    test('AI 关闭时四页帮助入口仍在且可打开（不随开关隐藏）', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      stub.aiEnabled = false;

      for (const path of ['/inbox', '/week', '/expenses', '/review']) {
        await page.goto(path);
        await expect(helpEntry(page)).toBeVisible();

        await openHelpDrawer(page);
        await expect(helpDrawer(page)).toBeVisible();

        await closeDialog(helpDrawer(page));
        await expect(helpDrawer(page)).toHaveCount(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 点 12：C 组确认界面三形态
  // -------------------------------------------------------------------------

  test.describe('点 12：C 组确认界面三形态', () => {
    test('拆分 Drawer / 排程建议区 / 记账解析区三形态齐备', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      await grantConsent(page);

      // C1：草稿面板（Drawer），确认前零写入。
      await page.goto('/inbox');
      await page.getByLabel('快速添加任务').fill('整理书桌');
      await page.getByRole('button', { name: '拆分任务', exact: true }).click();

      const breakdown = page.getByRole('dialog', { name: '拆分任务' });
      await expect(breakdown).toBeVisible();
      await expect(breakdown.locator('[data-variant="ai-scope-notice"]')).toHaveText(
        SCOPE_BREAKDOWN,
      );
      await expect(breakdown.locator('[data-breakdown-row-title]')).toHaveCount(2);
      await expect(breakdown.getByRole('button', { name: '确认创建', exact: true })).toBeVisible();
      expect(stub.aiConfirmCount).toBe(0);

      // C2：就地建议块（非浮层）。
      await page.goto('/week');
      await page.getByRole('checkbox', { name: '选择任务：任务甲' }).check();
      await page.getByRole('button', { name: '安排时间', exact: true }).click();

      const schedule = page.locator('section[aria-label="排程建议"]');
      await expect(schedule.getByText('上午精力更好', { exact: true })).toBeVisible();
      await expect(schedule.locator('[data-variant="ai-scope-notice"]')).toHaveText(SCOPE_SCHEDULE);

      // C3：同一 Drawer body 内的确认区。
      await page.goto('/expenses');
      await page.getByRole('button', { name: '记一笔', exact: true }).first().click();
      await page.getByRole('button', { name: '粘贴文本记一笔', exact: true }).click();
      await page.getByPlaceholder('午饭 35 元，餐饮').fill('午饭 35 元，餐饮');
      await page.getByRole('button', { name: '识别', exact: true }).click();

      await expect(page.locator('[data-expense-ai-amount]')).toHaveValue('35.00');
      await expect(
        page.getByText('请核对金额后确认，写入前不会保存。', { exact: true }),
      ).toBeVisible();
      await expect(page.locator('[data-variant="ai-scope-notice"]')).toHaveText(SCOPE_EXPENSE);
    });
  });

  // -------------------------------------------------------------------------
  // 点 13：D 周摘要固定文案与分层呈现
  // -------------------------------------------------------------------------

  test.describe('点 13：D 周摘要固定文案与分层呈现', () => {
    test('固定空态句 + 数据范围选择态（4 项、默认前两项）', async ({ page }) => {
      await installAiWizardStub(page);
      await grantConsent(page);
      await gotoWeeklyReview(page);

      const section = page.locator('section[aria-label="AI 摘要"]');
      await expect(section.getByText(WEEKLY_IDLE_TEXT, { exact: true })).toBeVisible();

      await section.getByRole('button', { name: '生成本周摘要', exact: true }).click();
      const scopeGroup = section.getByRole('group', { name: '数据范围' });
      await expect(scopeGroup).toBeVisible();
      await expect(scopeGroup.getByRole('checkbox')).toHaveCount(4);
      await expect(section.getByRole('checkbox', { name: '计划执行与时长' })).toBeChecked();
      await expect(section.getByRole('checkbox', { name: '重复延期' })).toBeChecked();
      await expect(section.getByRole('checkbox', { name: '开销摘要' })).not.toBeChecked();
      await expect(section.getByRole('checkbox', { name: '本周复盘回答' })).not.toBeChecked();
      await expect(section.locator('[data-variant="ai-scope-notice"]')).toHaveText(SCOPE_REVIEW);
    });

    test('实时请求：骨架 → 就绪（Badge、正文、禁区行）', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      await grantConsent(page);
      stub.aiDelayMs = 800;
      await gotoWeeklyReview(page);

      const section = page.locator('section[aria-label="AI 摘要"]');
      await section.getByRole('button', { name: '生成本周摘要', exact: true }).click();
      await section.getByRole('button', { name: '生成本周摘要', exact: true }).click();

      await expect(section.locator('span[aria-hidden="true"]')).toHaveCount(2);
      await expect(section.getByText('AI 建议', { exact: true })).toBeVisible();
      await expect(section.getByText('本周计划执行稳定。', { exact: true })).toBeVisible();
      await expect(section.getByText(FORBIDDEN_LINE, { exact: true })).toBeVisible();
    });

    test('降级：provider 故障落「AI 暂不可用」错误行', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      await grantConsent(page);
      stub.reviewOutcome = 'error';
      await gotoWeeklyReview(page);

      const section = page.locator('section[aria-label="AI 摘要"]');
      await section.getByRole('button', { name: '生成本周摘要', exact: true }).click();
      await section.getByRole('button', { name: '生成本周摘要', exact: true }).click();

      const notice = section.locator('[data-variant="ai-unavailable"]');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(AI_UNAVAILABLE_TEXT);
      await expect(notice.getByRole('button', { name: '重试', exact: true })).toBeVisible();
      await expect(section.getByText(FORBIDDEN_LINE, { exact: true })).toHaveCount(0);
    });
  });

  // -------------------------------------------------------------------------
  // 护栏：同意弹层 / 冻结文案 / 就地校验 / 接受与撤销
  // -------------------------------------------------------------------------

  test.describe('护栏：同意弹层 / 冻结文案 / 就地校验 / 接受与撤销', () => {
    test('护栏 2：同意弹层只出一次；取消不发 AI 请求；同意后跨页不再弹', async ({ page }) => {
      const stub = await installAiWizardStub(page);

      await page.goto('/inbox');
      await page.getByLabel('快速添加任务').fill('整理书桌');
      await page.getByRole('button', { name: '拆分任务', exact: true }).click();

      const consentDialog = page.getByRole('dialog', { name: '即将发送数据给 AI' });
      await expect(consentDialog).toBeVisible();
      await expect(page.locator('[data-ai-consent-agree]')).toBeVisible();
      // 同意之前一个 AI 请求都不该发出。
      expect(stub.aiRequests).toHaveLength(0);

      await consentDialog.getByRole('button', { name: '取消', exact: true }).click();
      await expect(consentDialog).toHaveCount(0);
      expect(stub.aiRequests).toHaveLength(0);

      // 再触发一次：仍旧出弹层；这次点「同意并继续」。
      await page.getByRole('button', { name: '拆分任务', exact: true }).click();
      await expect(consentDialog).toBeVisible();
      await page.locator('[data-ai-consent-agree]').click();

      await expect(page.getByRole('dialog', { name: '拆分任务' })).toBeVisible();
      await expect(page.locator('[data-breakdown-row-title]')).toHaveCount(2);
      await expect.poll(() => stub.aiRequests.length).toBeGreaterThanOrEqual(1);

      // 跨页再触发 AI 动作：同一会话不再弹同意层，请求照发。
      const before = stub.aiRequests.length;
      await page.goto('/week');
      await page.getByRole('checkbox', { name: '选择任务：任务甲' }).check();
      await page.getByRole('button', { name: '安排时间', exact: true }).click();

      const schedule = page.locator('section[aria-label="排程建议"]');
      await expect(schedule.getByText('上午精力更好', { exact: true })).toBeVisible();
      await expect(page.getByRole('dialog', { name: '即将发送数据给 AI' })).toHaveCount(0);
      await expect.poll(() => stub.aiRequests.length).toBeGreaterThan(before);
    });

    test('护栏 7：C3 未识别金额冻结句 + 不提供可点的「确认记账」', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      await grantConsent(page);
      stub.expenseOutcome = 'unrecognized';

      await page.goto('/expenses');
      await page.getByRole('button', { name: '记一笔', exact: true }).first().click();
      await page.getByRole('button', { name: '粘贴文本记一笔', exact: true }).click();
      await page.getByPlaceholder('午饭 35 元，餐饮').fill('午饭');
      await page.getByRole('button', { name: '识别', exact: true }).click();

      await expect(page.getByText(AMOUNT_NOT_RECOGNIZED, { exact: true })).toBeVisible();
      await expect(page.locator('[data-expense-ai-amount]')).toHaveValue('');
      await expect(page.getByRole('button', { name: '确认记账', exact: true })).toBeDisabled();
      expect(stub.aiConfirmCount).toBe(0);
    });

    test('护栏 3（UI 半边）：C1 清空标题即禁用确认并就地提示', async ({ page }) => {
      await installAiWizardStub(page);
      await grantConsent(page);

      await page.goto('/inbox');
      await page.getByLabel('快速添加任务').fill('整理书桌');
      await page.getByRole('button', { name: '拆分任务', exact: true }).click();

      const drawer = page.getByRole('dialog', { name: '拆分任务' });
      const firstTitle = drawer.locator('[data-breakdown-row-title]').first();
      await expect(firstTitle).toHaveValue('建议甲');

      const confirm = drawer.getByRole('button', { name: '确认创建', exact: true });
      await expect(confirm).toBeEnabled();

      await firstTitle.fill('');
      await expect(confirm).toBeDisabled();
      await expect(drawer.getByText('请填写任务标题', { exact: true })).toBeVisible();
    });

    test('护栏 8：C2 接受后 Toast 带「撤销」，撤销发出 DELETE', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      await grantConsent(page);

      await page.goto('/week');
      await page.getByRole('checkbox', { name: '选择任务：任务甲' }).check();
      await page.getByRole('button', { name: '安排时间', exact: true }).click();

      const row = page
        .locator('section[aria-label="排程建议"] li')
        .filter({ hasText: '上午精力更好' });
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: '接受', exact: true }).click();

      await expect(page.getByText('已加入时间线', { exact: true })).toBeVisible();
      const action = page.locator('[data-variant="toast-action"]');
      await expect(action).toHaveText('撤销');
      await expect.poll(() => stub.blockWrites.length).toBe(1);
      expect(stub.blockWrites[0]?.method).toBe('POST');
      expect(stub.blockWrites[0]?.url).toBe('/api/v1/schedule-blocks');

      await action.click();
      await expect(page.getByText('已撤销', { exact: true })).toBeVisible();
      await expect.poll(() => stub.blockDeletes.length).toBe(1);
      expect(stub.blockDeletes[0]?.method).toBe('DELETE');
      expect(stub.blockDeletes[0]?.url).toBe('/api/v1/schedule-blocks/sb-new-1');
    });

    test('护栏 8：C2 拒绝不落库（不产生任何写请求）', async ({ page }) => {
      const stub = await installAiWizardStub(page);
      await grantConsent(page);

      await page.goto('/week');
      await page.getByRole('checkbox', { name: '选择任务：任务甲' }).check();
      await page.getByRole('button', { name: '安排时间', exact: true }).click();

      const row = page
        .locator('section[aria-label="排程建议"] li')
        .filter({ hasText: '上午精力更好' });
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: '拒绝', exact: true }).click();

      await expect(page.getByText('上午精力更好', { exact: true })).toHaveCount(0);
      await expect(page.getByText('建议都已处理完。可以重新生成。', { exact: true })).toBeVisible();
      expect(stub.blockWrites).toHaveLength(0);
      expect(stub.blockDeletes).toHaveLength(0);
    });
  });
});
