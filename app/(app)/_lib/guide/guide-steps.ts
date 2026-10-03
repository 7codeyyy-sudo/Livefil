/**
 * 新手引导的四步定义与确定性判定（《UI 页面规范》v0.22 §5 A，AI-001）。
 *
 * ## 判定为什么用既有端点，而不是新加一个「引导进度」端点
 *
 * 四步各自对应一个"用户有没有做过这件事"的既有事实，而这些事实在现有契约里
 * 都问得到（目标详情带 `actions`、排程窗口、执行记录、当日复盘）。新加一个
 * 引导端点会引入服务端状态与一套新的失效规则，而引导进度本质是**纯客户端、
 * 可丢弃**的（丢了最多重看一遍，见 `guide-storage.ts`）。
 *
 * ## 四个判定落在哪个端点
 *
 * | 步 | 判定 | 端点 |
 * |---|---|---|
 * | 1 | 存在 ≥1 个行动 | `GET /goals?limit=100`（仅第一页）+ 逐个 `GET /goals/{goalId}` 读 `actions` |
 * | 2 | 存在 ≥1 个时间块 | `GET /schedule-blocks?from&to&timezone` |
 * | 3 | 存在 ≥1 条执行记录 | `GET /execution-logs?from&to&timezone&limit=1` |
 * | 4 | 当日复盘记录存在 | `GET /reviews/daily/{today}`（`data !== null`，无记录是 200 而非 404） |
 *
 * ## 两处与任务书逐字口径的偏差（均因契约上限，已在交付报告披露）
 *
 * - **步 2 的窗口**：契约上限是 `to <= from + 41`（含首尾共 42 天）。任务书的
 *   `[今天 − 42 天, 今天]` 是 43 天，会被 400 挡下，故取 `[今天 − 41 天, 今天]`。
 * - **步 3 的窗口**：`from` / `to` / `timezone` 在契约里是**必填**（schema 是
 *   `.strict()`），只给 `?limit=1` 会 400，故补 `[今天 − 91 天, 今天]`（契约
 *   允许 92 天窗口）。
 */

import { fetchJson } from '../api-client';
import { localCalendarDate } from '../queries';
import { fetchProfile } from '../identity-api';

/** 判定所需的两样上下文：用户时区下的今天，以及与契约对表用的时区。 */
export type GuideCheckContext = {
  /** 用户时区下的今天（`YYYY-MM-DD`）。 */
  readonly today: string;
  /**
   * 时区（IANA 名）。
   *
   * 优先取 `GET /me` 的 `timezone`（用户的真实设置），取不到时退回浏览器的
   * `Intl` 时区——判定的窗口宁可粗一档，也不能因为一次 `/me` 失败就整轮停摆。
   */
  readonly timezone: string;
};

/** 单步判定：给定上下文，答"这一步的事实存在吗"。 */
type GuideCheck = (context: GuideCheckContext, signal: AbortSignal) => Promise<boolean>;

/** 一步的冻结形态：卡文、主操作文案、落点与判定。 */
export type GuideStepDefinition = {
  /** 当前步卡文（§5 A 冻结文本，逐字使用）。 */
  readonly cardText: string;
  /** 主操作文案（§5 A 冻结文本）。 */
  readonly actionLabel: string;
  /** 主操作落点。 */
  readonly href: string;
  readonly check: GuideCheck;
};

/** 步数（四步，§5 A 冻结）。 */
export const TOTAL_GUIDE_STEPS = 4;

/**
 * 四步定义。文案**逐字**取自 §5 A，不许改写、不许加标点。
 *
 * 步 2 的落点是 `/week`（周视图）——本仓库里承担"把任务放进时间线"的那一页
 * （SCHED-003，见 `app/(app)/week/page.tsx` 的页头说明）。
 */
export const GUIDE_STEPS: readonly GuideStepDefinition[] = [
  {
    cardText: '写下你要做的第一件事',
    actionLabel: '去创建',
    href: '/goals',
    check: hasAnyAction,
  },
  {
    cardText: '把第一步放进时间线',
    actionLabel: '去安排',
    href: '/week',
    check: hasAnyScheduleBlock,
  },
  {
    cardText: '完成一件，记录一次',
    actionLabel: '去完成',
    href: '/today',
    check: hasAnyExecutionLog,
  },
  {
    cardText: '回答三问，完成第一次复盘',
    actionLabel: '去复盘',
    href: '/review',
    check: hasAnyDailyReview,
  },
];

/** 把任意数收进步数区间 `[0, 4]`；非整数或负数按 0 处理。 */
export function clampGuideStep(step: number): number {
  if (!Number.isInteger(step) || step < 0) {
    return 0;
  }
  return Math.min(step, TOTAL_GUIDE_STEPS);
}

/**
 * 从 `fromStep` 起逐步骤核对，返回**已连续通过的最长前缀长度**。
 *
 * 三条纪律：
 * 1. **分步独立失败**：某一步的请求失败只表示"这一轮判不出来"，就地停下、
 *    不推进也不回退（已完成的前缀早先那几轮已经写进进度，这里抹不掉）。
 * 2. **不抛给页面**：判定失败绝不能变成 `/today` 的错误态——引导条只是页面上
 *    的一块，它出问题的表现应该是"这次不推进"。
 * 3. **中途被中止**：请求带调用方的 `signal`，卸载即中止；中止按失败处理，
 *    返回值不推进（调用方还会再查一次 `signal.aborted`，见 `GuideBarContainer`）。
 *
 * @param fromStep 本轮从第几步开始核对（已完成的前缀不重复请求）。
 * @param signal 调用方的中止信号（组件卸载时触发）。
 * @returns 0–4 之间的步数；等于 `TOTAL_GUIDE_STEPS` 表示四步全通过。
 */
export async function evaluateGuide(fromStep: number, signal: AbortSignal): Promise<number> {
  let step = clampGuideStep(fromStep);
  if (step >= TOTAL_GUIDE_STEPS) {
    return TOTAL_GUIDE_STEPS;
  }

  const context: GuideCheckContext = {
    today: localCalendarDate(),
    timezone: await resolveTimeZone(signal),
  };

  for (; step < TOTAL_GUIDE_STEPS; step += 1) {
    const definition = GUIDE_STEPS[step];
    if (definition === undefined) {
      break;
    }

    let passed: boolean;
    try {
      passed = await definition.check(context, signal);
    } catch {
      // 失败安全（见函数说明第 1、2 条）：显式吞掉并停在当前步，
      // 由每轮重新核对来重试，不在这里做退避或计数。
      break;
    }

    if (!passed) {
      break;
    }
  }

  return step;
}

/* ------------------------------------------------------------------ */
/* 四个判定                                                            */
/* ------------------------------------------------------------------ */

/**
 * 步 1：存在 ≥1 个行动。
 *
 * ⚠️ **N+1 代价：最坏 1 + min(目标数, 100) 次请求，仅挂载与离开各跑一轮。**
 *
 * 目标列表不带行动，只能逐目标读详情；命中第一个有行动的即短路返回。这不构成
 * 性能问题，是因为它**只在引导条可见、且只在挂载/页面重新可见时**各跑一轮
 * （见 `GuideBarContainer`），从不轮询；而一旦某个目标有了行动，第一步就永久
 * 通过，后续轮次从第 2 步起核对，不再进这里。
 *
 * 本步与日期、时区无关，因此上下文参数有意不使用（`_context` 即"已知忽略"）。
 */
async function hasAnyAction(_context: GuideCheckContext, signal: AbortSignal): Promise<boolean> {
  const page = await fetchJson<{ readonly items: readonly { readonly id: string }[] }>(
    '/api/v1/goals?limit=100',
    signal,
  );

  for (const goal of page.data.items) {
    const detail = await fetchJson<{ readonly actions: readonly unknown[] }>(
      `/api/v1/goals/${goal.id}`,
      signal,
    );
    if (detail.data.actions.length > 0) {
      return true;
    }
  }

  // 目标数为 0（含上限内的 100 个目标都没行动）→ 第一步未完成。
  return false;
}

/** 步 2：`[今天 − 41 天, 今天]` 窗口内存在 ≥1 个时间块（窗口上限见文件说明）。 */
async function hasAnyScheduleBlock(
  context: GuideCheckContext,
  signal: AbortSignal,
): Promise<boolean> {
  const params = new URLSearchParams({
    from: shiftCalendarDate(context.today, -41),
    to: context.today,
    timezone: context.timezone,
  });

  const page = await fetchJson<{ readonly items: readonly unknown[] }>(
    `/api/v1/schedule-blocks?${params.toString()}`,
    signal,
  );
  return page.data.items.length > 0;
}

/** 步 3：`[今天 − 91 天, 今天]` 窗口内存在 ≥1 条执行记录（`limit=1` 够判定）。 */
async function hasAnyExecutionLog(
  context: GuideCheckContext,
  signal: AbortSignal,
): Promise<boolean> {
  const params = new URLSearchParams({
    from: shiftCalendarDate(context.today, -91),
    to: context.today,
    timezone: context.timezone,
    limit: '1',
  });

  const page = await fetchJson<{ readonly items: readonly unknown[] }>(
    `/api/v1/execution-logs?${params.toString()}`,
    signal,
  );
  return page.data.items.length > 0;
}

/**
 * 步 4：当日复盘记录存在。
 *
 * 无记录时契约给的是 **200 + `data: null`**（不是 404），所以这里判 `data` 是否
 * 为非空对象；把 404 当空态会得到完全相反的结论（404 恰恰表示端点或日期有问题）。
 */
async function hasAnyDailyReview(
  context: GuideCheckContext,
  signal: AbortSignal,
): Promise<boolean> {
  const envelope = await fetchJson<unknown>(`/api/v1/reviews/daily/${context.today}`, signal);
  return envelope.data !== null && envelope.data !== undefined;
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/** 用户时区：先问 `/me`，取不到再退回浏览器时区（见 `GuideCheckContext.timezone`）。 */
async function resolveTimeZone(signal: AbortSignal): Promise<string> {
  try {
    const timezone = (await fetchProfile(signal)).data.timezone;
    if (timezone !== '') {
      return timezone;
    }
  } catch {
    // 离线 / 会话不可用：退回浏览器时区（不静默丢弃——下面就是兜底值本身）。
  }

  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * 日历日平移（`YYYY-MM-DD`）。
 *
 * 走 UTC 解析而不是 `new Date('...')` 的本地时区解析：后者在夏令时切换日会
 * 得到"少一天/多一天"的结果，而这里要的是**纯日历加减**。
 */
function shiftCalendarDate(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}
