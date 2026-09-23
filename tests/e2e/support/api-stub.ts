/**
 * 浏览器用例的 API 桩（UI-004）。
 *
 * ## 为什么需要它
 *
 * 从 UI-004 起，五个状态页会按《UI 页面规范》v0.14 §4.7 用**真实端点**取数，
 * 而本批**不建业务端点**。于是不拦截的话，每个访问这些页面的用例都会产生一次
 * 404——那是「数据源还没接上」的**预期表现**，但浏览器会把它记成一条
 * resource error。
 *
 * 这会污染那些「断言页面没有控制台错误」的用例：它们要查的是**样式或脚本**
 * 的问题，而不是一个已知且预期的 404。把这些请求接成正常的空结果，断言才
 * 指向真正的问题。
 *
 * ## 为什么不是每个 spec 各写一遍
 *
 * 三处重复的 `route.fulfill` 里藏着同一个约定（信封形状、路径 glob）；写三遍
 * 就有三个可能漂移的版本。放在这里，改信封形状只需改一处。
 *
 * 文件名不含 `.spec.ts`，所以 Playwright 不会把它当作用例文件收集。
 */
import type { Page } from '@playwright/test';

/** 《接口文档》§1.3 的分页信封，空结果。 */
const EMPTY_TASKS_ENVELOPE = { data: [], meta: { hasMore: false } };

/**
 * 把任务查询接成「成功但为空」。
 *
 * 必须在 `page.goto` **之前**调用：Playwright 的 `page.route` 只对注册之后
 * 发出的请求生效，而页面挂载后立刻就会取数。
 */
export async function stubTaskQueryAsEmpty(page: Page): Promise<void> {
  await page.route('**/api/v1/tasks*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_TASKS_ENVELOPE),
    }),
  );
  /**
   * 今日页自 UI-007 起走 `GET /today` 聚合——数据源迁移后这里必须一并 stub，
   * 否则真实请求在本地 500 / 在 CI 因无 DATABASE_URL 必红（审查重要 7，
   * 按 tokens 用例注释的原意：stub 数据源而不是给 CI 加数据库）。
   */
  await page.route('**/api/v1/today*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
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
        },
        meta: { requestId: 'stub' },
      }),
    }),
  );
}

/**
 * 页面上的阻塞式错误态（`ErrorState`）。
 *
 * **必须排除 Next 的 RouteAnnouncer**：它渲染一个 `role="alert"` 的空 div
 * （`#__next-route-announcer__`），与 `ErrorState` 的 `role="alert"` 撞在一起，
 * 会让 `getByRole('alert')` 直接变成 strict-mode 违规——而那个元素与我们要
 * 断言的东西毫无关系。
 */
export function errorState(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}
