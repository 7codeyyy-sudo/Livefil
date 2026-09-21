/**
 * 五个页面的查询定义（UI-004，《UI 页面规范》v0.14 §4.7）。
 *
 * ## 为什么暂放这里
 *
 * 按项目分层，页面的取数定义属于**模块的表现层**（`src/modules/<模块>/presentation`）。
 * 但那 13 个模块目前只有空目录骨架，应用层要等 Phase 3 才建立（模块 presentation
 * 只能消费 application，而 application 现在什么都没有）。所以本批把它们放在
 * 路由组私有的 `_lib/` 下（`_` 前缀目录不参与 Next 路由）。
 *
 * **记债**：Phase 3 建立模块应用层时，五条定义分别迁入
 * `src/modules/{tasks,goals,expenses,reviews}/presentation`。届时应连带把
 * DTO 换成服务端 schema 推导出的真实类型，而不是这里的「最小形状」。
 *
 * ## 端点只用《接口文档》里已定义的那些
 *
 * 例如今日任务用 `GET /tasks` 的 `from`/`to` 查询参数，而不是 `/tasks/today`——
 * 后者在接口文档里不存在，写它会落进 `GET /tasks/{taskId}` 的语义（把 `today`
 * 当成任务 ID），拿到一个和意图完全无关的 404。
 */

import { fetchJson, type ApiEnvelope } from './api-client';

/**
 * 列表项的最小形状。
 *
 * 本批不渲染任何实体字段（非空成功分支由各页占位），所以只需要一个身份字段
 * 让类型不至于退化成 `unknown`。真实字段随 Phase 3 的领域模型补齐。
 */
export type ListItem = { readonly id: string };

/** 页面查询定义：取数原语要的三样东西。 */
export type PageQuery<T> = {
  /** `useAsyncQuery` 的 queryKey（§4.7：本批只用于将来扩展与测试可辨）。 */
  readonly queryKey: readonly string[];
  /** 版本化 URL。 */
  readonly url: string;
  /** 空判据：信封 → 是否「没有内容」。 */
  readonly isEmpty: (envelope: ApiEnvelope<T>) => boolean;
};

/**
 * 本地日历日（`YYYY-MM-DD`）。
 *
 * 用**本地时区**而不是 UTC：用户说的「今天」是他手表上的今天。SRS 要求
 * 「时间使用 UTC 和用户时区」——这里取的是后者；IAM-002 落地 `timezone`
 * 设置后应改为按用户配置的时区计算（记债）。
 *
 * 导出给「目标详情 → 今日任务」复用（L514：`dueDate` 必给今天，否则任务
 * 不会出现在今日视图）。
 */
export function localCalendarDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

/**
 * 日期参数取值。
 *
 * 在模块求值时算一次：五条定义都在页面挂载时被读，跨午夜开着页面不刷新
 * 属于可接受的行为（本批也没有真实数据可过期）。若将来需要跨午夜自更新，
 * 应把它提升为状态而不是在这里加计时器。
 */
const TODAY = localCalendarDate();

function isEmptyList(envelope: ApiEnvelope<readonly ListItem[]>): boolean {
  return envelope.data.length === 0;
}

/** 今日（`/today`）：当日任务。 */
export const TODAY_QUERY: PageQuery<readonly ListItem[]> = {
  queryKey: ['tasks', 'today', TODAY],
  // 接口文档 §GET /tasks 的 `from`/`to`。参数格式（ISO 日期 vs 时间戳）文档
  // 未细述，本批按 ISO 日期实现——**记债**：SYNC-001 落地时对齐。
  url: `/api/v1/tasks?from=${TODAY}&to=${TODAY}`,
  isEmpty: isEmptyList,
};

/** 收件箱（`/inbox`）：未安排的任务。 */
export const INBOX_QUERY: PageQuery<readonly ListItem[]> = {
  queryKey: ['tasks', 'inbox'],
  // `status: 'inbox'` 的取值来自《接口文档》§POST /tasks 的示例（创建到收件箱）。
  url: '/api/v1/tasks?status=inbox',
  isEmpty: isEmptyList,
};

/** 目标（`/goals`）。 */
export const GOALS_QUERY: PageQuery<readonly ListItem[]> = {
  queryKey: ['goals'],
  url: '/api/v1/goals',
  isEmpty: isEmptyList,
};

/** 开销（`/expenses`）。 */
export const EXPENSES_QUERY: PageQuery<readonly ListItem[]> = {
  queryKey: ['expenses'],
  url: '/api/v1/expenses',
  isEmpty: isEmptyList,
};

/**
 * 日复盘（`/review`）。
 *
 * 这里返回的是**单个对象**而不是列表，所以空判据也不同。
 *
 * ⚠️ **接口文档没有定义「当日无复盘」的响应**（`GET /reviews/daily/{date}`
 * 只写了「返回指定日期的事实摘要和用户填写内容」）。本批按 `data: null`
 * 表示「这天还没复盘」实现——它是「成功但没有内容」，与「失败」必须分开：
 * 404 是失败（错误态），不是空态。**记债**：需在接口文档补明该语义，
 * 并与 SYNC-001 的实现对齐；若最终定为别的形状，这里只需改这一处判据。
 */
export type DailyReviewData = { readonly id: string } | null;

export const REVIEW_QUERY: PageQuery<DailyReviewData> = {
  queryKey: ['reviews', 'daily', TODAY],
  url: `/api/v1/reviews/daily/${TODAY}`,
  isEmpty: (envelope) => envelope.data === null,
};

/* ------------------------------------------------------------------ */
/* Phase 3（UI-005/006）：真实数据形状与游标分页取数                      */
/* ------------------------------------------------------------------ */

/** 任务条目（`GET /tasks` 返回项的最小消费形状，字段见接口文档 §4）。 */
export type TaskItem = {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dueDate: string | null;
  readonly estimatedMinutes: number | null;
  readonly minimumVersion: string | null;
  readonly lifeAreaId: string | null;
  readonly goalId: string | null;
  readonly version: number;
};

/** 目标条目（`GET /goals` 返回项的最小消费形状）。 */
export type GoalItem = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly targetDate: string | null;
  readonly resultMetric: {
    readonly current: number | null;
    readonly target: number | null;
    readonly unit: string | null;
    readonly note: string | null;
  } | null;
  readonly version: number;
};

/** 行动条目（目标详情里的行动）。 */
export type ActionItem = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly estimatedMinutes: number | null;
  readonly minimumVersion: string | null;
  readonly version: number;
};

/** 目标详情（`GET /goals/{goalId}` 的 `data`）。 */
export type GoalDetailData = {
  readonly goal: GoalItem;
  readonly actions: readonly ActionItem[];
  readonly actionProgress: {
    readonly total: number;
    readonly completed: number;
    readonly active: number;
    readonly paused: number;
  };
  readonly expenses: readonly unknown[];
};

/** 生活领域条目（选择器用）。 */
export type LifeAreaItem = {
  readonly id: string;
  readonly name: string;
};

/** 游标分页的返回形状（`meta` 里的 `nextCursor` / `hasMore`，§1.3）。 */
export type CursorPage<T> = {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

/** 从信封 meta 里读游标分页字段（缺省安全：没有 meta 时按"没有更多"处理）。 */
function readCursorPage<T>(envelope: ApiEnvelope<{ readonly items: readonly T[] }>): CursorPage<T> {
  const meta = envelope.meta;
  return {
    items: envelope.data.items,
    nextCursor: typeof meta?.['nextCursor'] === 'string' ? meta['nextCursor'] : null,
    hasMore: meta?.['hasMore'] === true,
  };
}

/**
 * 收件箱分页取数（`GET /tasks?status=inbox`，UI v0.19 §5 冻结口径：
 * 安排→planned、归档→archived 即离开列表）。
 */
export function makeInboxQueryFn(): (
  signal: AbortSignal,
  cursor: string | null,
) => Promise<CursorPage<TaskItem>> {
  return (signal, cursor) => {
    const params = new URLSearchParams({ status: 'inbox', limit: '20' });
    if (cursor !== null) {
      params.set('cursor', cursor);
    }
    return fetchJson<{ readonly items: readonly TaskItem[] }>(
      `/api/v1/tasks?${params.toString()}`,
      signal,
    ).then(readCursorPage);
  };
}

/** 目标列表取数（`GET /goals`，活跃目标优先的选择器与列表共用一条）。 */
export function makeGoalsQueryFn(
  status?: 'active',
): (signal: AbortSignal, cursor: string | null) => Promise<CursorPage<GoalItem>> {
  return (signal, cursor) => {
    const params = new URLSearchParams({ limit: '50' });
    if (status !== undefined) {
      params.set('status', status);
    }
    if (cursor !== null) {
      params.set('cursor', cursor);
    }
    return fetchJson<{ readonly items: readonly GoalItem[] }>(
      `/api/v1/goals?${params.toString()}`,
      signal,
    ).then(readCursorPage);
  };
}

/** 生活领域选择器的取数（`GET /life-areas`，不含已归档）。 */
export function fetchLifeAreas(signal: AbortSignal): Promise<readonly LifeAreaItem[]> {
  return fetchJson<{ readonly items: readonly LifeAreaItem[] }>('/api/v1/life-areas', signal).then(
    (envelope) => envelope.data.items,
  );
}
