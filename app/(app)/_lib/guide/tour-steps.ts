/**
 * 新手引导（逐页签导览）的步骤定义与页面映射
 * （《UI 页面规范》v0.25「新手引导形态升版补节」，AI-007）。
 *
 * ## 与 v0.22 §5 A 四步「引导条」的关系
 *
 * v0.22 §5 A 的页顶引导条形态**作废**（关系表逐条声明），本节取而代之：
 * 载体改为全屏引导层、触发改为「首次使用逐页签」、推进改为手动「我知道了」。
 * 本文件是 v0.25 B 表 13 步的唯一代码准据——锚点取值与页面归属**逐字冻结**，
 * 不许改写。
 *
 * ## 为什么卡文是「标题 + 正文」两段
 *
 * § B「卡文口径」要求卡文只说「这块是干什么的、下一步做什么」，不复述 AI-002
 * 的「当前页下一步」表。标题承担「这块是什么」，正文承担「下一步做什么」；
 * 两者都是本文件内的静态字符串，不取数、不发请求。
 *
 * ## 分页触发的必要条件
 *
 * 每页的第一枚锚点在页面成功态后即可取得（§ A「分页触发口径」）。锚点缺失时
 * 该步**整体跳过**（§ B「区块缺失即跳过」，写死）——判定与跳过逻辑落在
 * `GuideTourLayer`，本文件只描述「有哪些步、每步打哪个锚点」。
 */

/** 参与导览的六个页签（§ A：六页各记一枚「已看过」）。 */
export type TourPageKey = 'today' | 'inbox' | 'goals' | 'expenses' | 'review' | 'settings';

/** 单步定义：页签归属、锚点取值（`data-tour`）、卡文两段。 */
export type TourStepDefinition = {
  readonly page: TourPageKey;
  /** `data-tour` 的取值（§ B 表「锚点」列，逐字冻结）。 */
  readonly anchor: string;
  /** 卡文标题（「这块是干什么的」）。 */
  readonly title: string;
  /** 卡文正文（「下一步做什么」）。 */
  readonly text: string;
};

/** 六个页签的顺序（也是帮助 Drawer 进度回显的分母）。 */
export const TOUR_PAGE_KEYS: readonly TourPageKey[] = [
  'today',
  'inbox',
  'goals',
  'expenses',
  'review',
  'settings',
];

/** 页签 → 页面名（眉标「第 n / M 步 · 页面名」用，与主导航文案一致）。 */
export const TOUR_PAGE_LABELS: Readonly<Record<TourPageKey, string>> = {
  today: '今日',
  inbox: '收件箱',
  goals: '目标',
  expenses: '开销',
  review: '复盘',
  settings: '设置',
};

/**
 * 13 步定义（§ B 表，逐行）。
 *
 * `/today` 3 步、其余五页各 2 步；顺序即页内步序（眉标的「本页子序号」用它）。
 */
export const TOUR_STEPS: readonly TourStepDefinition[] = [
  // ── /today（3 步）─────────────────────────────────────────────────────
  {
    page: 'today',
    anchor: 'today-timeline',
    title: '今天的时间线',
    text: '按钟点排好的时间块都在这里；完成或延后都在行内处理，不用跳页。',
  },
  {
    page: 'today',
    anchor: 'today-unscheduled',
    title: '还没安排的事',
    text: '没放进时间的任务堆在这里；挑一件排进时间线就能开始。',
  },
  {
    page: 'today',
    anchor: 'help-entry',
    title: '帮助与引导',
    text: '点这个问号打开帮助抽屉：每个页签是干什么的、这一页的下一步是什么，都写在里面。',
  },

  // ── /inbox（2 步）────────────────────────────────────────────────────
  {
    page: 'inbox',
    anchor: 'inbox-quick-add',
    title: '先记下来',
    text: '想到什么先写进这个框，回车即进收件箱；不用当场想清楚怎么归类。',
  },
  {
    page: 'inbox',
    anchor: 'inbox-list',
    title: '收件箱的条目',
    text: '每条都还能改：安排时间、转成目标行动，或直接归档。',
  },

  // ── /goals（2 步）────────────────────────────────────────────────────
  {
    page: 'goals',
    anchor: 'goals-create',
    title: '写下第一个目标',
    text: '给它起个名字就能保存，目标日期可以以后再补。',
  },
  {
    page: 'goals',
    anchor: 'goals-list',
    title: '目标列表',
    text: '每个目标带着结果进度与行动汇总；点进去可以拆成这周能做的步骤。',
  },

  // ── /expenses（2 步）─────────────────────────────────────────────────
  {
    page: 'expenses',
    anchor: 'expenses-create',
    title: '几秒记一笔',
    text: '金额必填，分类与关联都能先留空，不打断记录节奏。',
  },
  {
    page: 'expenses',
    anchor: 'expenses-categories',
    title: '分类管理',
    text: '分类只服务开销，可以新增、改名或停用；停用不会删掉历史记录。',
  },

  // ── /review（2 步）───────────────────────────────────────────────────
  {
    page: 'review',
    anchor: 'review-segments',
    title: '日复盘 / 周复盘',
    text: '日复盘回答今天的三问；周复盘按整周汇总计划与结果——切到「周复盘」就能看到。',
  },
  {
    page: 'review',
    anchor: 'review-daily',
    title: '今天的三问',
    text: '几行字就够，重点是给明天留一个明确的动作。',
  },

  // ── /settings（2 步）─────────────────────────────────────────────────
  {
    page: 'settings',
    anchor: 'settings-region',
    title: '地区与语言',
    text: '决定日期、时间的显示方式与一周从哪天开始；改完记得保存本区。',
  },
  {
    page: 'settings',
    anchor: 'settings-appearance',
    title: '外观',
    text: '挑一款右下角的装饰背景，选中即生效，不用保存。',
  },
];

/** 每个页签的步数（眉标分母 M；`/today` 为 3，其余为 2）。 */
export const TOUR_STEP_COUNT: Readonly<Record<TourPageKey, number>> = {
  today: 3,
  inbox: 2,
  goals: 2,
  expenses: 2,
  review: 2,
  settings: 2,
};

/** 当前页签的步定义（按 `TOUR_STEPS` 内的相对顺序）。 */
export function tourStepsForPage(page: TourPageKey): readonly TourStepDefinition[] {
  return TOUR_STEPS.filter((step) => step.page === page);
}

/**
 * 路由 → 页签。
 *
 * 只认六个精确路由（§ A 六页）；子路由（如 `/goals/{id}`）与其它页面不参与
 * 导览，返回 `null`（导览层据此整块不出现）。
 */
export function tourPageKeyForPath(pathname: string): TourPageKey | null {
  switch (pathname) {
    case '/today':
      return 'today';
    case '/inbox':
      return 'inbox';
    case '/goals':
      return 'goals';
    case '/expenses':
      return 'expenses';
    case '/review':
      return 'review';
    case '/settings':
      return 'settings';
    default:
      return null;
  }
}

/** 眉标文案：「第 n / M 步 · 页面名」（n 为本页子序号、M 为本页步数，§ C）。 */
export function tourEyebrow(page: TourPageKey, stepNumber: number): string {
  return `第 ${String(stepNumber)} / ${String(TOUR_STEP_COUNT[page])} 步 · ${TOUR_PAGE_LABELS[page]}`;
}
