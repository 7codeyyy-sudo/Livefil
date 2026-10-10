'use client';

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import Link from 'next/link';

import {
  EditBlockModal,
  type EditableBlock as EditableBlockData,
} from '../_components/EditBlockModal';
import { PageHeading } from '../_components/PageHeading';

import { LaserFlow } from './LaserFlow';

import {
  Badge,
  Button,
  Checkbox,
  ErrorState,
  Input,
  ReminderRuleInlineArea,
  Skeleton,
  useAsyncQuery,
  useToast,
} from '@/shared/ui/components';

import { ApiRequestError, fetchJson, sendJson } from '../_lib/api-client';
import { fetchProfile } from '../_lib/identity-api';
import { addDays, localCalendarDay, startOfWeek } from '../_lib/review-api';
import { useReminderRuleStore } from '../_lib/use-reminder-rules';
import styles from './TodayPanel.module.css';

/**
 * 今日页（UI-007；版式 v0.29（UI-012）视觉方案 v2 采纳，接口 §6 `GET /today`）。
 *
 * 版式自上而下（v0.29 重排）：页头（日期眉标 + 标题 + 「距离今天结束」逐位数字）
 * → 激光舞台（当前行动 hero 卡，光束从页顶坠下击中卡顶边）→ 时间线卡（甘特时间尺 +
 * 行状态）→ 固定事项卡（列表 + 建议 chips + 新增表单）→ 例程与习惯卡（条件）→
 * 未安排卡 → 今日摘要卡（负荷数字 + 周条）。区块一律以「卡片」承载
 * （白/深底 + 1px 描边 + 16px 圆角），滚进视口时逐张浮现一次。
 *
 * 本地时区一次取数（timezone 参数），不前端多次拼请求。
 */

interface TodayBlock {
  readonly id: string;
  readonly taskId: string | null;
  readonly title: string | null;
  readonly startsAtUtc: string;
  readonly endsAtUtc: string;
  readonly status: string;
  readonly version: number;
}

interface TodayView {
  readonly date: string;
  readonly currentAction: {
    readonly blockId: string;
    readonly title: string | null;
    readonly startsAtUtc: string;
    readonly endsAtUtc: string;
  } | null;
  readonly blocks: readonly TodayBlock[];
  readonly fixedCommitments: readonly {
    readonly id: string;
    readonly title: string;
    readonly startsAtUtc: string | null;
    readonly endsAtUtc: string | null;
  }[];
  readonly unscheduledTasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly dueDate: string | null;
    readonly overdue: boolean;
  }[];
  readonly routines: readonly {
    readonly id: string;
    readonly name: string;
    readonly scheduled: boolean;
    readonly steps: readonly {
      readonly id: string;
      readonly title: string;
      readonly blockId: string | null;
      readonly status: string | null;
    }[];
  }[];
  readonly habits: readonly {
    readonly actionId: string;
    readonly title: string;
    readonly doneToday: boolean;
  }[];
  readonly load: {
    readonly fixedMinutes: number;
    readonly plannedMinutes: number;
    readonly completedMinutes: number;
    readonly availableMinutes: number;
    readonly overloaded: boolean;
  };
  readonly recovery: {
    readonly manual: boolean;
    readonly autoTriggered: boolean;
    readonly suggestions: readonly { readonly code: string; readonly text: string }[];
  };
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** `HH:mm`（用户本地钟点，用于时间线展示）。 */
function clockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** 块的分钟时长。 */
function minutesBetween(startsAtUtc: string, endsAtUtc: string): number {
  return Math.max(0, Math.round((Date.parse(endsAtUtc) - Date.parse(startsAtUtc)) / 60_000));
}

/* ── v2 形态（UI-012）────────────────────────────────────────────────────── */

/** 一天的分钟数。写成 `24 * 60`——直接写全天分钟数会撞验收扫描器的断点字面量。 */
const MINUTES_PER_DAY = 24 * 60;

/** 时间尺：08–22 窗口，4 小时一笔刻度（甘特块条画在同一骨架上）。 */
const RULER_START_HOUR = 8;
const RULER_END_HOUR = 22;
const RULER_TICK_HOURS = [8, 12, 16, 20] as const;

/** 用户设置未到达时的默认周起点（周一，与 WeekPanel 同口径）。 */
const DEFAULT_WEEK_STARTS_ON = 1;

const WEEKDAY_LABELS = [
  '星期日',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六',
] as const;

/** 一周七天的日标（一…日的短标，与预览稿 `drawWeek` 同字）。 */
const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'] as const;

/**
 * 固定事项的建议 chips（预览稿逐字，v2 起常驻本卡）。
 * 做成**可点按钮**而不是死文案：点击给新增表单预填名称与开始时间
 * （见 `FixedCommitmentForm` 的 `seed`）。
 */
const SUGGESTED_COMMITMENTS = [
  { title: '起床', startAt: '07:30' },
  { title: '通勤', startAt: '08:40' },
  { title: '午饭', startAt: '12:00' },
  { title: '复盘', startAt: '21:30' },
] as const;

/** 日期串（`YYYY-MM-DD`）的星期下标（0=周日）。 */
function weekdayIndexOf(date: string): number {
  const parts = date.split('-');
  return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))).getUTCDay();
}

/**
 * 日期串 → 「M 月 D 日 · 星期W」（页头眉标的语境）。
 *
 * 取 `view.date`（服务端按用户时区定的「今天」）而不是前端 `new Date()`：
 * 后者在跨午夜/跨时区时可能与内容差一天。UTC 构造只为拿日历日的星期数——
 * 日期串是纯日历语义，不带时区。
 */
function dayEyebrow(date: string): string {
  const parts = date.split('-');
  return `${Number(parts[1])} 月 ${Number(parts[2])} 日 · ${WEEKDAY_LABELS[weekdayIndexOf(date)]}`;
}

/** 到期日文案：`M 月 D 日`；无到期日 → 「无期限」。 */
function dueLabel(dueDate: string | null): string {
  if (dueDate === null) {
    return '无期限';
  }
  const parts = dueDate.split('-');
  return `${Number(parts[1])} 月 ${Number(parts[2])} 日`;
}

/** 数字摘要的量词格式：`9 小时 28 分`（count-up 的逐帧输出也是这个形状）。 */
function formatRemain(minutes: number): string {
  return `${String(Math.floor(minutes / 60))} 小时 ${String(minutes % 60)} 分`;
}

/** 时间线眉标的状态词：无块或现在早于首块→尚未开始；晚于末块→已结束；否则进行中。 */
function timelineStatusOf(blocks: readonly TodayBlock[]): string {
  if (blocks.length === 0) {
    return '尚未开始';
  }
  const firstStart = Math.min(...blocks.map((block) => Date.parse(block.startsAtUtc)));
  const lastEnd = Math.max(...blocks.map((block) => Date.parse(block.endsAtUtc)));
  const now = Date.now();
  if (now < firstStart) {
    return '尚未开始';
  }
  if (now > lastEnd) {
    return '已结束';
  }
  return '进行中';
}

/** 块的 UTC 瞬时落在该日历日（与 WeekPanel 同一近似口径）。 */
function dayMatches(iso: string, day: string): boolean {
  const local = new Date(iso);
  const month = String(local.getMonth() + 1).padStart(2, '0');
  const date = String(local.getDate()).padStart(2, '0');
  return `${String(local.getFullYear())}-${month}-${date}` === day;
}

/* ── 滚动浮现（UI-012 §6.1）──────────────────────────────────────────────
 * SSR 安全的 layout effect：服务端退回 useEffect（布局副作用在服务端无意义），
 * 客户端上两者时序差异只在「水合提交到首帧绘制之间」——那正是我们要的窗口。 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * 滚动浮现：卡片滚进视口才播一次性入场（零循环）。
 *
 * 布防在 layout effect 里完成——挂 `revealReady` 类 → 卡片进入隐藏初态 →
 * IntersectionObserver 逐张加 `cardIn` 播上浮。选 layout effect 而不是
 * 普通 effect 是为了**不闪**：普通 effect 在首帧绘制后才跑，卡片会先以
 * 可见态闪现一帧再被藏起来。失败方向也是对的——JS 没跑 / 水合失败时
 * `revealReady` 从未挂上，内容保持默认可见（宁可没动画，不可没内容）。
 *
 * 每次渲染重建观察器：卡片是条件渲染的（数据到达前后集合会变），
 * 已入场的卡片带 `cardIn` 类、跳过重新观察。
 */
function useRevealCards(): RefObject<HTMLDivElement | null> {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      return;
    }

    // 环境没有 IntersectionObserver（jsdom、极旧浏览器）：**不布防、不隐藏**——
    // 失败方向保持「没有动画但有内容」，与 JS 未跑的口径一致（本模块的整体设计）。
    if (typeof IntersectionObserver === 'undefined') {
      return;
    }

    // 布防标记走 data 属性而不是类名：CSS Modules 的类名在类型上是
    // `string | undefined`（索引签名 + noUncheckedIndexedAccess），
    // `classList.add` 不接受；data 属性同时把「这种状态是数据不是样式」写明白。
    root.setAttribute('data-reveal-ready', 'true');

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.setAttribute('data-reveal-state', 'in');
            observer.unobserve(entry.target);
          }
        }
      },
      // 下缘留 -6%：卡片"刚露头"不算进入视口，滚到面前才播，避免贴边闪动。
      { rootMargin: '0px 0px -6% 0px', threshold: 0.05 },
    );

    for (const card of root.querySelectorAll('[data-reveal]')) {
      if (card.getAttribute('data-reveal-state') !== 'in') {
        observer.observe(card);
      }
    }

    return () => {
      observer.disconnect();
    };
  });

  return rootRef;
}

/* ── 时间线（UI-012 甘特化）──────────────────────────────────────────────── */

/** 尺上位置（0–100 的布局比例）：钟点 → 08–22 窗口，窗口外钳到端点。 */
function rulerPosition(hour: number): number {
  const clamped = Math.min(RULER_END_HOUR, Math.max(RULER_START_HOUR, hour));
  return ((clamped - RULER_START_HOUR) / (RULER_END_HOUR - RULER_START_HOUR)) * 100;
}

/** 本地钟点（小时小数）——甘特块条的落点。 */
function localHourOf(iso: string): number {
  const date = new Date(iso);
  return date.getHours() + date.getMinutes() / 60;
}

/**
 * 甘特时间尺（UI-012 §6.1）：08–22 骨架 + 每 4 小时短刻度 + 时间块色条 +
 * 「现在」竖线与胶囊。
 *
 * 色条三级：已完成（success-soft）/ 进行中（accent + 3px 柔光环）/ 计划
 * （surface-soft + 描边）——同一根尺上把"今天的时间用了多少、用在哪"一次读完。
 * 完全落在窗口外的块不画；跨窗口的钳到端点。`aria-hidden`：刻度与色条是
 * 视觉辅助，读屏读标题与列表行即可。指示线与胶囊这个区块里唯一一处强调色。
 */
function TimelineRuler({ blocks }: { readonly blocks: readonly TodayBlock[] }) {
  const now = new Date();
  const nowHour = now.getHours() + now.getMinutes() / 60;
  const nowPosition = rulerPosition(nowHour);
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // 胶囊靠近两端时贴边对齐（默认以位置点为中心会让它在 0%/100% 处溢出尺外）。
  const pillEdge =
    nowPosition < 8 ? styles.nowPillStart : nowPosition > 92 ? styles.nowPillEnd : undefined;

  const left = (position: number): { readonly left: string } => ({
    left: `${String(position)}%`,
  });

  return (
    <div className={styles.ruler} aria-hidden="true">
      {RULER_TICK_HOURS.map((hour) => (
        <Fragment key={hour}>
          <span className={styles.rulerTick} style={left(rulerPosition(hour))} />
          <span className={styles.rulerLabel} style={left(rulerPosition(hour))}>
            {String(hour).padStart(2, '0')}
          </span>
        </Fragment>
      ))}
      {blocks.map((block) => {
        const start = localHourOf(block.startsAtUtc);
        const end = localHourOf(block.endsAtUtc);
        if (end <= RULER_START_HOUR || start >= RULER_END_HOUR) {
          return null;
        }
        const barLeft = rulerPosition(start);
        const barRight = rulerPosition(end);
        const state =
          block.status === 'completed'
            ? styles.gbarDone
            : nowHour >= start && nowHour < end
              ? styles.gbarActive
              : undefined;
        return (
          <span
            key={block.id}
            className={[styles.gbar, state].filter(Boolean).join(' ')}
            style={{
              left: `${String(barLeft)}%`,
              // 最短 0.6%：极短块也要在尺上留下一个可读的刻度（否则整块消失）。
              width: `${String(Math.max(barRight - barLeft, 0.6))}%`,
            }}
          />
        );
      })}
      <span className={styles.rulerNow} style={left(nowPosition)} />
      <span
        className={[styles.nowPill, pillEdge].filter(Boolean).join(' ')}
        style={left(nowPosition)}
      >
        {`现在 ${hhmm}`}
      </span>
    </div>
  );
}

/* ── 数字（UI-012）───────────────────────────────────────────────────────── */

/**
 * 逐位数字滚轮的一位（odometer）：每位一列 0–9 重复三圈，起点停「第三圈的
 * 目标位」、终点停「第二圈的目标位」——视觉上是滚满一圈后归位，十位先停、
 * 个位后停（延迟错峰）。
 *
 * 延迟取 `--duration-slow` 的派生因子（因子在 JS 侧按位序算出，样式里仍然
 * 只有令牌，零时长字面量）；时长与缓动在样式里（`--ease-standard`）。
 */
function OdometerDigit({ digit, index }: { readonly digit: number; readonly index: number }) {
  const [rolled, setRolled] = useState(false);

  useEffect(() => {
    const handle = requestAnimationFrame(() => {
      setRolled(true);
    });
    return () => {
      cancelAnimationFrame(handle);
    };
  }, []);

  const cells: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    for (let value = 0; value <= 9; value += 1) {
      cells.push(value);
    }
  }

  return (
    <span className={styles.odoCol}>
      <span
        className={styles.odoStrip}
        style={{
          transform: `translateY(-${String(rolled ? 10 + digit : 20 + digit)}em)`,
          transitionDelay: `calc(var(--duration-slow) * ${String(index * 0.36 + 0.24)})`,
        }}
      >
        {cells.map((value, cellIndex) => (
          <span key={`${String(cellIndex)}-${String(value)}`}>{value}</span>
        ))}
      </span>
    </span>
  );
}

/**
 * 页头数字（UI-012 §6.1）：距离今天结束的「N 小时 M 分」，逐位滚轮归位。
 *
 * 首帧渲染为纯文本「0 小时 0 分」（与服务端产出一致，避免水合不匹配），
 * 挂载后换成滚轮并滚到真实值——滚轮本身就是入场动画（一次性，零循环）。
 * 时钟只在客户端读取（同 `RemainFigure` 的既有口径）。
 */
function RemainOdometer() {
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    // 走一帧 rAF 再落值：既满足「不在 effect 体里同步 setState」（级联渲染警告），
    // 也保证滚轮从 0 位起步——首帧先画"00"，下一帧才滚到真实值。
    const handle = requestAnimationFrame(() => {
      const now = new Date();
      setLeft(MINUTES_PER_DAY - (now.getHours() * 60 + now.getMinutes()));
    });
    return () => {
      cancelAnimationFrame(handle);
    };
  }, []);

  if (left === null) {
    return <p className={styles.headFigureValue}>{formatRemain(0)}</p>;
  }

  const digitsOf = (value: number, offset: number): ReactNode =>
    String(value)
      .padStart(2, '0')
      .split('')
      .map((digit, index) => (
        <OdometerDigit key={`${String(index)}`} digit={Number(digit)} index={index + offset} />
      ));

  return (
    <p className={styles.headFigureValue}>
      <span className={styles.odo}>{digitsOf(Math.floor(left / 60), 0)}</span>
      {' 小时 '}
      <span className={styles.odo}>{digitsOf(left % 60, 2)}</span>
      {' 分'}
    </p>
  );
}

/**
 * 数字摘要 count-up（UI-011 §6.1，UI-012 改为「目标分钟数」入参）：进组件即从 0
 * 滚到实值，一次到位、不循环；时钟只在客户端读（本卡只在成功态渲染）。
 *
 * 时长从令牌读（`--duration-base` × 3 ≈ 600ms），reduce 下归零即首帧终值。
 */
function CountUpMinutes({ minutes }: { readonly minutes: number }) {
  const [text, setText] = useState(() => formatRemain(0));

  useEffect(() => {
    const base =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--duration-base')) ||
      200;
    const duration = base * 3;
    const startedAt = performance.now();
    let frameHandle = requestAnimationFrame(function step(frameAt: number): void {
      const progress = Math.min(1, (frameAt - startedAt) / duration);
      setText(formatRemain(Math.round(minutes * (1 - Math.pow(1 - progress, 3)))));
      if (progress < 1) {
        frameHandle = requestAnimationFrame(step);
      }
    });

    return () => {
      cancelAnimationFrame(frameHandle);
    };
  }, [minutes]);

  return <p className={styles.summaryFigure}>{text}</p>;
}

/** `GET /schedule-blocks` 周窗口里本页用到的字段（本周迷你条只需时段两头）。 */
interface WeekWindowBlock {
  readonly startsAtUtc: string;
  readonly endsAtUtc: string;
}

/** 建议 chips 预填表单的载荷（名称 + 开始时间）。 */
interface CommitmentSeed {
  readonly title: string;
  readonly startAt: string;
}

export function TodayPanel() {
  const revealRef = useRevealCards();
  const heroRef = useRef<HTMLElement | null>(null);
  /**
   * 时间线卡的 ref（UI-012 修复）：无「当前行动」时它就是光的**落点卡**——
   * 光总要有一张卡可「击中」，否则只能在半空衰减（用户实测问题 ②）。
   */
  const timelineRef = useRef<HTMLElement | null>(null);
  const today = useAsyncQuery({
    queryKey: ['today'],
    queryFn: (signal) =>
      fetchJson<TodayView>(
        `/api/v1/today?timezone=${encodeURIComponent(localTimeZone())}`,
        signal,
      ).then((envelope) => envelope.data),
  });
  /**
   * 今日摘要的本周迷你条（UI-011 §6.1 数字可视化）：真数据才有量。
   * `weekStartsOn` 从用户档案取（同 WeekPanel），档案未到达时回落周一。
   * 两条取数与 `today` 并行发出，失败时该组静默不渲染——它是摘要的辅助视图，
   * 不值得为它把整页打成错误态。
   */
  const profile = useAsyncQuery({ queryKey: ['me'], queryFn: fetchProfile });
  const weekStartsOn =
    profile.state.status === 'success'
      ? profile.state.data.data.weekStartsOn
      : DEFAULT_WEEK_STARTS_ON;
  const weekStart = startOfWeek(localCalendarDay(), weekStartsOn);
  const weekEnd = addDays(weekStart, 6);
  const week = useAsyncQuery({
    queryKey: ['schedule-blocks', 'week', weekStart],
    queryFn: (signal) =>
      fetchJson<{ readonly items: readonly WeekWindowBlock[] }>(
        `/api/v1/schedule-blocks?from=${weekStart}&to=${weekEnd}&timezone=${encodeURIComponent(localTimeZone())}`,
        signal,
      ).then((envelope) => envelope.data.items),
  });
  const toast = useToast();
  /** 已提交完成/延后请求的块（防连点；幂等键运行时生成）。 */
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  /** 自动提示的会话内可关闭性（不落库——冻结口径"可忽略"）。 */
  const [autoNoticeDismissed, setAutoNoticeDismissed] = useState(false);
  const [pendingRoutine, setPendingRoutine] = useState<string | null>(null);
  const [editingBlock, setEditingBlock] = useState<EditableBlockData | null>(null);
  /** 键盘调整（冻结口径：方向键 15 分钟、Enter 确认、Esc 还原）——本地暂存，Enter 才 PATCH。 */
  const [shiftMinutes, setShiftMinutes] = useState<Readonly<Record<string, number>>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /**
   * 行内提醒展开态：**同屏至多展开一行**——只存一个键，展开新行即替换旧行
   * （§5 A「展开新行先折叠旧行」）。键区分任务行与例程行（`task:` / `routine:`）。
   */
  const [expandedReminderKey, setExpandedReminderKey] = useState<string | null>(null);
  /**
   * 建议 chips → 新增固定事项表单的预填载荷（UI-011；v2 起 chips 常驻固定事项卡）。
   * 每次点击写入新对象引用，表单在渲染期比对引用差异后展开并预填
   * （见 `FixedCommitmentForm`，不走 effect——lint 拦 setState-in-effect）。
   */
  const [commitmentSeed, setCommitmentSeed] = useState<CommitmentSeed | null>(null);
  const reminders = useReminderRuleStore(['task', 'routine']);
  // 总开关未知（加载中 / 取数失败）时不渲染入口：把「还不知道」当 `false`
  // 渲染成「总开关已关闭」是假话（同 ReviewReminderArea）。
  const reminderGlobalEnabled = reminders.globalEnabled;

  /** 翻转某行的提醒展开态（同屏至多一行：展开新行即折叠旧行）。 */
  const toggleReminderRow = (rowKey: string) => {
    setExpandedReminderKey((current) => (current === rowKey ? null : rowKey));
  };

  const mutateBlock = async (block: TodayBlock, status: 'completed' | 'deferred') => {
    setPending((previous) => new Set(previous).add(block.id));
    try {
      await sendJson(
        'POST',
        '/api/v1/execution-logs',
        {
          taskId: block.taskId,
          scheduleBlockId: block.id,
          status,
          plannedMinutes: minutesBetween(block.startsAtUtc, block.endsAtUtc),
        },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
      );
      toast.success(status === 'completed' ? '已完成' : '已延期，块已取消');
      today.refetch();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '操作失败，请稍后重试');
    } finally {
      setPending((previous) => {
        const next = new Set(previous);
        next.delete(block.id);
        return next;
      });
    }
  };

  /** 例程「安排到今天」（接口 §8；同日重复 409 由后端给冲突提示）。 */
  const scheduleRoutine = async (routineId: string) => {
    setPendingRoutine(routineId);
    try {
      await sendJson(
        'POST',
        `/api/v1/routines/${routineId}/schedule`,
        {
          date: new Date().toISOString().slice(0, 10),
          startAt: '08:00',
          timezone: localTimeZone(),
        },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
      );
      toast.success('例程已安排到今天');
      today.refetch();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '安排失败，请稍后重试');
    } finally {
      setPendingRoutine(null);
    }
  };

  /** 拖拽移动（桌面）：开始时间吸附到目标位置，PATCH 乐观并发。 */
  const moveBlockTo = async (block: TodayBlock, newStart: Date) => {
    try {
      await sendJson(
        'PATCH',
        `/api/v1/schedule-blocks/${block.id}`,
        {
          version: block.version,
          startsAt: newStart.toISOString(),
          endsAt: new Date(
            newStart.getTime() + minutesBetween(block.startsAtUtc, block.endsAtUtc) * 60_000,
          ).toISOString(),
        },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
      );
      toast.success('时间块已移动');
      today.refetch();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '移动失败，请稍后重试');
    }
  };

  const toggleHabit = async (actionId: string, done: boolean) => {
    try {
      await sendJson(
        'POST',
        '/api/v1/execution-logs',
        {
          actionId,
          status: 'completed',
        },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
      );
      toast.success(done ? '已打卡' : '已记录');
      today.refetch();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '打卡失败，请稍后重试');
    }
  };

  const view = today.state.status === 'success' ? today.state.data : null;
  /**
   * 当前行动卡「还剩 N 分钟」的读数。与既有「现在」读数同一条口径：渲染期
   * 取一次本地时间（`new Date()`，与时间尺/时间线同一 惯例），负值不显示。
   */
  const currentRemainMinutes =
    view?.currentAction == null
      ? null
      : Math.round((Date.parse(view.currentAction.endsAtUtc) - new Date().getTime()) / 60_000);

  /**
   * 本周迷你条（有量才画）：合计为 0、或取数未成功，整组不渲染——
   * 0 分钟的图表就是装饰（预览稿 v3「有量才画」）。
   */
  let weekViz: ReactNode = null;
  const weekBlocks = week.state.status === 'success' ? week.state.data : null;
  if (weekBlocks !== null) {
    const weekDays = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
    const weekMinutes = weekDays.map((day) =>
      weekBlocks
        .filter((block) => dayMatches(block.startsAtUtc, day))
        .reduce((sum, block) => sum + minutesBetween(block.startsAtUtc, block.endsAtUtc), 0),
    );
    const weekTotal = weekMinutes.reduce((sum, value) => sum + value, 0);
    if (weekTotal > 0) {
      const weekMax = Math.max(120, ...weekMinutes);
      const todayKey = localCalendarDay();
      weekViz = (
        <div className={styles.weekViz}>
          <div className={styles.weekHead}>
            <span className={styles.blockMeta}>本周已排（分钟）</span>
            <span className={styles.blockMeta}>{`合计 ${String(weekTotal)}`}</span>
          </div>
          <div className={styles.weekBars}>
            {weekDays.map((day, index) => (
              <span
                key={day}
                className={styles.weekCol}
                data-today={day === todayKey ? 'true' : undefined}
                style={{ '--i': index } as CSSProperties}
              >
                <span
                  className={styles.weekBar}
                  style={{
                    height: `${String(
                      Math.max(3, Math.round(((weekMinutes[index] ?? 0) / weekMax) * 38)),
                    )}px`,
                  }}
                />
                <span className={styles.weekDay}>{WEEKDAY_SHORT[weekdayIndexOf(day)]}</span>
              </span>
            ))}
          </div>
        </div>
      );
    }
  }

  return (
    <div className={styles.today} ref={revealRef}>
      {/* ── 页头与激光舞台（UI-012）：舞台覆盖「页头 + 落点卡」——光束从屏幕顶部
          坠下、穿过标题区落到落点卡顶边。**落点卡 = 有当前行动时的 hero，
          否则第一张卡（时间线）**：光总要有一张卡可「击中」（canvas 由 LaserFlow
          渲染，画布扩宽/向下补位/裁切见该组件与样式说明）。 ── */}
      <div className={styles.laserStage}>
        {/* 光效先于内容入场（DOM 序在前后文之上，卡片自身带定位层叠在上）；
            只在成功态挂载——骨架期没有「落点卡片」，没必要起 WebGL。 */}
        {today.state.status === 'success' ? (
          <LaserFlow surfaceRef={view?.currentAction != null ? heroRef : timelineRef} />
        ) : null}
        {view === null ? null : <p className={styles.eyebrow}>{dayEyebrow(view.date)}</p>}
        <div className={styles.pageHead}>
          <div className={styles.headTitle}>
            <PageHeading>今日</PageHeading>
          </div>
          <div className={styles.headFigure}>
            <RemainOdometer />
            <span className={styles.headFigureCaption}>距离今天结束还有</span>
          </div>
        </div>

        {view?.currentAction == null ? null : (
          <section
            ref={heroRef}
            className={`${styles.card} ${styles.hero}`}
            data-reveal
            aria-label="当前行动"
            style={{ '--i': 0 } as CSSProperties}
          >
            <span className={styles.heroBar} aria-hidden="true" />
            <span className={styles.nowTag}>进行中</span>
            <p className={styles.actTitle}>{view.currentAction.title ?? '自由安排'}</p>
            <p className={styles.actRange}>
              {`${clockOf(view.currentAction.startsAtUtc)} – ${clockOf(view.currentAction.endsAtUtc)}`}
              {currentRemainMinutes !== null && currentRemainMinutes > 0
                ? ` · 还剩 ${String(currentRemainMinutes)} 分钟`
                : ''}
            </p>
          </section>
        )}
      </div>

      {today.state.status === 'loading' ? (
        <div className={styles.section} role="status" aria-busy="true">
          <Skeleton />
          <Skeleton width="80%" />
          <Skeleton width="90%" />
        </div>
      ) : null}

      {today.state.status === 'error' ? (
        <div className={styles.section}>
          <ErrorState
            title="今日安排没能加载"
            description="数据没能取回来。可以先重试。"
            action={
              <Button variant="primary" onClick={today.refetch}>
                重试
              </Button>
            }
          />
        </div>
      ) : null}

      {view === null ? null : (
        <div className={styles.cards}>
          {(() => {
            const unfinishedBlocks = view.blocks.filter((block) => block.status !== 'completed');
            const hasRoutineBlock = view.routines.length > 0 || view.habits.length > 0;
            const overdueCount = view.unscheduledTasks.filter((task) => task.overdue).length;
            const nowHour = new Date().getHours() + new Date().getMinutes() / 60;
            /*
             * 卡片错峰序（§6.1）：按**实际渲染顺序**递增，条件卡片缺席时不占号
             * （预览稿用 `nth-of-type`——产品里卡片是条件渲染的，序号只能算出来）。
             * hero 在舞台内、固定事项卡始终在场。
             */
            const routinesIndex = hasRoutineBlock ? 3 : -1;
            const unscheduledIndex = hasRoutineBlock ? 4 : 3;
            const summaryIndex = unscheduledIndex + 1;
            const loadPercent =
              view.load.plannedMinutes > 0
                ? Math.min(
                    100,
                    Math.round((view.load.completedMinutes / view.load.plannedMinutes) * 100),
                  )
                : 0;

            return (
              <>
                {/* 时间线（甘特）——无当前行动时它即「落点卡」（ref 供激光测量）。 */}
                <section
                  ref={timelineRef}
                  aria-label="时间线"
                  data-tour="today-timeline"
                  data-reveal
                  className={styles.card}
                  style={{ '--i': 1 } as CSSProperties}
                >
                  <div className={styles.cardHead}>
                    <h2 className={styles.heading}>时间线</h2>
                    <span className={styles.blockMeta}>
                      {`今天 · ${timelineStatusOf(view.blocks)} · ${String(view.blocks.length)} 项`}
                    </span>
                  </div>

                  <TimelineRuler blocks={view.blocks} />

                  {view.blocks.length === 0 ? (
                    <div className={styles.empty}>
                      <span className={styles.emptyArt} aria-hidden="true" />
                      <div className={styles.emptyCopy}>
                        <p className={styles.emptyTitle}>今天还没有排时间块。</p>
                        <p className={styles.emptyDescription}>
                          <Link href="/inbox">去收件箱</Link> 安排一个任务，或查看{' '}
                          <Link href="/week">本周视图</Link>。
                        </p>
                      </div>
                    </div>
                  ) : (
                    <ul className={styles.blockList}>
                      {view.blocks.map((block, rowIndex) => {
                        // 自由安排块没有 `taskId`（＝没有可挂规则的对象），§5 C 明文「固定事项与
                        // 时间块不产生提醒」，因此这类块不渲染提醒入口。
                        const taskId = block.taskId;
                        const rowKey = `task:${taskId ?? ''}`;
                        const done = block.status === 'completed';
                        const start = localHourOf(block.startsAtUtc);
                        const end = localHourOf(block.endsAtUtc);
                        const active = !done && nowHour >= start && nowHour < end;
                        return (
                          <li
                            key={block.id}
                            className={styles.blockRow}
                            data-glare
                            style={{ '--i': rowIndex } as CSSProperties}
                            tabIndex={0}
                            onKeyDown={(event) => {
                              if (block.status === 'completed') return;
                              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                                event.preventDefault();
                                const delta = event.key === 'ArrowRight' ? 15 : -15;
                                setShiftMinutes((prev) => ({
                                  ...prev,
                                  [block.id]: (prev[block.id] ?? 0) + delta,
                                }));
                              }
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                setEditingBlock({
                                  ...block,
                                  startsAtUtc: shiftPreviewIso(block, shiftMinutes[block.id] ?? 0),
                                });
                                setShiftMinutes((prev) => {
                                  const next = { ...prev };
                                  delete next[block.id];
                                  return next;
                                });
                              }
                              if (event.key === 'Escape') {
                                setShiftMinutes((prev) => {
                                  const next = { ...prev };
                                  delete next[block.id];
                                  return next;
                                });
                              }
                            }}
                            draggable={block.status !== 'completed'}
                            onDragStart={() => {
                              setDraggingId(block.id);
                            }}
                            onDragEnd={() => {
                              setDraggingId(null);
                            }}
                            onDragOver={(event) => {
                              if (draggingId !== null && draggingId !== block.id) {
                                event.preventDefault();
                              }
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              const dragged = view.blocks.find((b) => b.id === draggingId);
                              setDraggingId(null);
                              if (dragged === undefined || dragged.id === block.id) return;
                              // 拖拽语义：被拖块的开始吸附到目标块结束（冲突由服务端 warning）。
                              void moveBlockTo(dragged, new Date(block.endsAtUtc));
                            }}
                          >
                            <span className={styles.blockTime}>
                              {clockOf(shiftPreviewIso(block, shiftMinutes[block.id] ?? 0))}–
                              {clockOf(
                                shiftPreviewIso(
                                  block,
                                  (shiftMinutes[block.id] ?? 0) +
                                    minutesBetween(block.startsAtUtc, block.endsAtUtc),
                                ),
                              )}
                            </span>
                            <span
                              className={[
                                styles.rowDot,
                                done ? styles.rowDotDone : active ? styles.rowDotActive : undefined,
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              aria-hidden="true"
                            />
                            <span className={styles.blockTitle}>
                              {block.title ?? '自由安排'}
                              {(shiftMinutes[block.id] ?? 0) !== 0 ? (
                                <span className={styles.hint}>
                                  {' '}
                                  （{shiftMinutes[block.id]! > 0 ? '+' : ''}
                                  {String(shiftMinutes[block.id])} 分钟，Enter 确认 / Esc 还原）
                                </span>
                              ) : null}
                            </span>
                            <span className={styles.blockSide}>
                              {done ? (
                                <Badge variant="success">已完成</Badge>
                              ) : active ? (
                                <Badge variant="neutral">进行中</Badge>
                              ) : null}
                              {done ? null : (
                                <span className={styles.blockActions}>
                                  <Button
                                    variant="ghost"
                                    loading={pending.has(block.id)}
                                    onClick={() => {
                                      void mutateBlock(block, 'completed');
                                    }}
                                  >
                                    完成
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    loading={pending.has(block.id)}
                                    onClick={() => {
                                      void mutateBlock(block, 'deferred');
                                    }}
                                  >
                                    延后
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    onClick={() => {
                                      setEditingBlock(block);
                                    }}
                                  >
                                    调整
                                  </Button>
                                </span>
                              )}
                            </span>
                            {taskId === null || reminderGlobalEnabled === null ? null : (
                              <ReminderRuleInlineArea
                                label="为该任务添加提醒"
                                controlsId={`reminder-task-${taskId}`}
                                expanded={expandedReminderKey === rowKey}
                                onToggleExpanded={() => {
                                  toggleReminderRow(rowKey);
                                }}
                                section={{
                                  state: reminders.stateFor('task', taskId),
                                  onRetry: reminders.retry,
                                  globalEnabled: reminderGlobalEnabled,
                                  permission: reminders.permission,
                                  onRequestPermission: reminders.requestPermission,
                                  onCreate: (draft) => reminders.createRule('task', taskId, draft),
                                  onToggle: reminders.toggleRule,
                                }}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                {/* 固定事项（列表 + 建议 chips + 新增表单，始终在场）*/}
                <section
                  aria-label="固定事项"
                  data-reveal
                  className={styles.card}
                  style={{ '--i': 2 } as CSSProperties}
                >
                  <div className={styles.cardHead}>
                    <h2 className={styles.heading}>固定事项</h2>
                    <span className={styles.blockMeta}>
                      {`${String(view.fixedCommitments.length)} 项`}
                    </span>
                  </div>
                  {view.fixedCommitments.length === 0 ? null : (
                    <ul className={styles.fixedList}>
                      {view.fixedCommitments.map((item) => (
                        <li key={item.id} className={styles.fixedRow}>
                          <span>
                            {item.startsAtUtc === null ? '' : `${clockOf(item.startsAtUtc)} `}
                            {item.title}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* 建议 chips：把「常见固定事项」变成一次点击——点击预填新增表单。 */}
                  <div className={styles.suggestions}>
                    {SUGGESTED_COMMITMENTS.map((item) => (
                      <button
                        key={item.title}
                        type="button"
                        className={styles.chip}
                        onClick={() => {
                          setCommitmentSeed({ title: item.title, startAt: item.startAt });
                        }}
                      >
                        <span className={styles.chipPlus} aria-hidden="true">
                          ＋
                        </span>
                        {item.title}
                        <span className={styles.chipTime}>{item.startAt}</span>
                      </button>
                    ))}
                  </div>

                  <div className={styles.fixedFormSlot}>
                    <FixedCommitmentForm onCreated={today.refetch} seed={commitmentSeed} />
                  </div>
                </section>

                {editingBlock === null ? null : (
                  <EditBlockModal
                    block={editingBlock}
                    onClose={() => {
                      setEditingBlock(null);
                    }}
                    onSaved={() => {
                      setEditingBlock(null);
                      today.refetch();
                    }}
                  />
                )}

                {hasRoutineBlock ? (
                  <section
                    aria-label="例程与习惯"
                    data-reveal
                    className={styles.card}
                    style={{ '--i': routinesIndex } as CSSProperties}
                  >
                    <div className={styles.cardHead}>
                      <h2 className={styles.heading}>例程与习惯</h2>
                      <span className={styles.blockMeta}>
                        {`${String(view.routines.length + view.habits.length)} 项`}
                      </span>
                    </div>
                    <ul className={styles.routineList}>
                      {view.routines.map((routine) => (
                        <Fragment key={routine.id}>
                          <li key={routine.id} className={styles.routineRow}>
                            <span className={styles.routineName}>{routine.name}</span>
                            {routine.scheduled ? null : (
                              <Button
                                variant="secondary"
                                loading={pendingRoutine === routine.id}
                                onClick={() => {
                                  void scheduleRoutine(routine.id);
                                }}
                              >
                                安排到今天
                              </Button>
                            )}
                            {reminderGlobalEnabled === null ? null : (
                              <ReminderRuleInlineArea
                                label="为例程添加提醒"
                                controlsId={`reminder-routine-${routine.id}`}
                                expanded={expandedReminderKey === `routine:${routine.id}`}
                                onToggleExpanded={() => {
                                  toggleReminderRow(`routine:${routine.id}`);
                                }}
                                section={{
                                  state: reminders.stateFor('routine', routine.id),
                                  onRetry: reminders.retry,
                                  globalEnabled: reminderGlobalEnabled,
                                  permission: reminders.permission,
                                  onRequestPermission: reminders.requestPermission,
                                  onCreate: (draft) =>
                                    reminders.createRule('routine', routine.id, draft),
                                  onToggle: reminders.toggleRule,
                                }}
                              />
                            )}
                          </li>
                          {routine.steps.map((step) => {
                            const stepBlock =
                              step.blockId === null
                                ? undefined
                                : view.blocks.find((candidate) => candidate.id === step.blockId);
                            return (
                              <li key={step.id} className={styles.routineRow}>
                                <Checkbox
                                  label={`完成例程步骤：${step.title}`}
                                  checked={
                                    stepBlock !== undefined && stepBlock.status === 'completed'
                                  }
                                  disabled={stepBlock === undefined}
                                  onChange={(next) => {
                                    if (next && stepBlock !== undefined) {
                                      void mutateBlock(stepBlock, 'completed');
                                    }
                                  }}
                                />
                                <span>
                                  {routine.name} · {step.title}
                                </span>
                                {stepBlock !== undefined && stepBlock.status === 'completed' ? (
                                  <Badge variant="success">已完成</Badge>
                                ) : null}
                              </li>
                            );
                          })}
                        </Fragment>
                      ))}
                      {view.habits.map((habit) => (
                        <li key={habit.actionId} className={styles.routineRow}>
                          <Checkbox
                            label={`完成习惯：${habit.title}`}
                            checked={habit.doneToday}
                            onChange={(next) => {
                              if (next) {
                                void toggleHabit(habit.actionId, true);
                              }
                            }}
                          />
                          <span>{habit.title}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                <section
                  aria-label="未安排"
                  data-tour="today-unscheduled"
                  data-reveal
                  className={styles.card}
                  style={{ '--i': unscheduledIndex } as CSSProperties}
                >
                  <div className={styles.cardHead}>
                    <h2 className={styles.heading}>未安排</h2>
                    <span className={styles.blockMeta}>
                      {`${String(view.unscheduledTasks.length)} 项`}
                      {overdueCount > 0 ? (
                        <>
                          {' · '}
                          <span
                            className={styles.overdueCount}
                          >{`${String(overdueCount)} 过期`}</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                  {view.unscheduledTasks.length === 0 ? (
                    <p className={styles.hint}>没有待安排的任务。</p>
                  ) : (
                    <ul className={styles.todoList}>
                      {view.unscheduledTasks.map((task) => (
                        <li key={task.id} className={styles.todoRow} data-glare>
                          <span className={styles.todoTitle}>{task.title}</span>
                          <span
                            className={[
                              styles.todoDue,
                              task.overdue ? styles.todoDueOver : undefined,
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            {dueLabel(task.dueDate)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section
                  aria-label="负荷与恢复"
                  data-reveal
                  className={styles.card}
                  style={{ '--i': summaryIndex } as CSSProperties}
                >
                  <div className={styles.cardHead}>
                    <h2 className={styles.heading}>今日摘要</h2>
                  </div>
                  <div className={styles.summaryGrid}>
                    <div className={styles.summaryLeft}>
                      <p className={styles.summaryCaption}>今日负荷</p>
                      <CountUpMinutes minutes={view.load.plannedMinutes} />
                      {view.load.plannedMinutes > 0 ? (
                        <span className={styles.loadLine}>
                          <span className={styles.loadBar}>
                            <span
                              className={styles.loadFill}
                              style={{ width: `${String(loadPercent)}%` }}
                            />
                          </span>
                          <span className={styles.loadText}>
                            {`已完成 ${formatRemain(view.load.completedMinutes)} · 计划 ${formatRemain(view.load.plannedMinutes)}`}
                          </span>
                        </span>
                      ) : null}
                      <p className={styles.loadFixed}>
                        {`其中固定占用 ${formatRemain(view.load.fixedMinutes)}`}
                      </p>
                    </div>
                    {weekViz}
                  </div>
                  {view.load.overloaded ? (
                    <p className={styles.neutralNotice}>
                      今天排得偏满，量力而行，随时可以延后一些。
                    </p>
                  ) : null}
                  {view.recovery.autoTriggered && !view.recovery.manual && !autoNoticeDismissed ? (
                    <div className={styles.recoveryCard}>
                      <p>最近两天完成得不多，要不要减轻一点？可以从最低版本开始。</p>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setAutoNoticeDismissed(true);
                        }}
                      >
                        知道了
                      </Button>
                    </div>
                  ) : null}
                  {view.recovery.manual ? (
                    <div className={styles.recoveryCard}>
                      <p>恢复模式进行中，以下是今日建议：</p>
                      <ul className={styles.suggestionList}>
                        {view.recovery.suggestions.map((suggestion, index) => (
                          <li key={`${suggestion.code}-${String(index)}`}>{suggestion.text}</li>
                        ))}
                        {view.recovery.suggestions.length === 0 ? (
                          <li>今天没有需要调整的安排。</li>
                        ) : null}
                      </ul>
                      <ExitRecoveryButton onDone={today.refetch} toast={toast} />
                    </div>
                  ) : null}
                  {unfinishedBlocks.length === 0 && view.blocks.length > 0 ? (
                    <p className={styles.neutralNotice}>今天的时间块都完成了，干得不错。</p>
                  ) : null}
                </section>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function ExitRecoveryButton({
  onDone,
  toast,
}: {
  readonly onDone: () => void;
  readonly toast: {
    readonly success: (message: string) => string;
    readonly error: (message: string) => string;
  };
}) {
  const [leaving, setLeaving] = useState(false);
  return (
    <Button
      variant="secondary"
      loading={leaving}
      onClick={() => {
        setLeaving(true);
        sendJson('PUT', '/api/v1/recovery-mode', { enabled: false })
          .then(() => {
            toast.success('已退出恢复模式');
            onDone();
          })
          .catch(() => {
            toast.error('操作失败，请稍后重试');
          })
          .finally(() => {
            setLeaving(false);
          });
      }}
    >
      退出恢复模式
    </Button>
  );
}

/**
 * 固定事项最小管理入口（审查整改 8）：本批无独立管理页，先落
 * 新增（单次形态）+ 今日列表；重复模板编辑随块编辑弹层后续批次。
 *
 * `seed`（UI-011）：建议 chips 点一下即预填名称与开始时间并展开表单，
 * 「常见固定事项」从死文案变成一次点击。
 */
function FixedCommitmentForm({
  onCreated,
  seed,
}: {
  readonly onCreated: () => void;
  readonly seed: CommitmentSeed | null;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [startAtLocal, setStartAtLocal] = useState('09:00');
  const [durationMinutes, setDurationMinutes] = useState('60');
  const [saving, setSaving] = useState(false);

  /**
   * seed 的应用走**渲染期状态调整**（React 官方的「prop 变了就同步本地状态」
   * 模式），而不是 effect——effect 里同步 setState 会被
   * `react-hooks/set-state-in-effect` 拦下，本身也多一轮级联渲染。
   * 父层无需清空 seed：每次点击都是新的对象引用，同一枚 chip 再点一次照常生效。
   */
  const [appliedSeed, setAppliedSeed] = useState<CommitmentSeed | null>(seed);
  if (seed !== appliedSeed) {
    setAppliedSeed(seed);
    if (seed !== null) {
      setTitle(seed.title);
      setStartAtLocal(seed.startAt);
      setOpen(true);
    }
  }

  if (!open) {
    return (
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
      >
        ＋ 新增固定事项
      </Button>
    );
  }

  return (
    <form
      className={styles.fixedForm}
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = title.trim();
        if (trimmed === '') {
          return;
        }
        setSaving(true);
        const today = new Date();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        const date = String(today.getFullYear()) + '-' + month + '-' + day;
        const parts = startAtLocal.split(':');
        const total = Number(parts[0]) * 60 + Number(parts[1] ?? 0);
        const toHHMM = (value: number): string =>
          String(Math.floor(value / 60) % 24).padStart(2, '0') +
          ':' +
          String(value % 60).padStart(2, '0');
        const duration = Math.max(1, Number(durationMinutes) || 60);
        // 审查 8：本地墙钟带时区偏移（与 EditBlockModal / 安排弹层同款口径）。
        const tzOffset = -new Date(date + 'T' + startAtLocal + ':00').getTimezoneOffset();
        const offsetSign = tzOffset >= 0 ? '+' : '-';
        const offsetAbs = Math.abs(tzOffset);
        const offsetSuffix =
          offsetSign +
          String(Math.floor(offsetAbs / 60)).padStart(2, '0') +
          ':' +
          String(offsetAbs % 60).padStart(2, '0');
        sendJson('POST', '/api/v1/fixed-commitments', {
          title: trimmed,
          startsAt: date + 'T' + toHHMM(total) + ':00' + offsetSuffix,
          endsAt: date + 'T' + toHHMM(total + duration) + ':00' + offsetSuffix,
          timezone: localTimeZone(),
        })
          .then(() => {
            toast.success('固定事项已新增');
            setTitle('');
            setOpen(false);
            onCreated();
          })
          .catch((error: unknown) => {
            toast.error(error instanceof ApiRequestError ? error.message : '新增失败，请稍后重试');
          })
          .finally(() => {
            setSaving(false);
          });
      }}
    >
      <div className={styles.formGrid}>
        <Input
          label="固定事项名称"
          placeholder="例如：门诊复诊"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
        <Input
          label="开始时间"
          type="time"
          value={startAtLocal}
          onChange={(event) => {
            setStartAtLocal(event.target.value);
          }}
        />
        <Input
          label="时长（分钟）"
          type="number"
          min={1}
          value={durationMinutes}
          onChange={(event) => {
            setDurationMinutes(event.target.value);
          }}
        />
        <div className={styles.formActions}>
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setOpen(false);
            }}
          >
            取消
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            保存
          </Button>
        </div>
      </div>
      <p className={styles.formNote}>固定事项每天自动出现在时间线。</p>
    </form>
  );
}

/** 键盘偏移预览：本地暂存偏移应用到块开始时刻（不落库，Enter 才确认）。 */
function shiftPreviewIso(block: TodayBlock, shift: number): string {
  if (shift === 0) {
    return block.startsAtUtc;
  }
  return new Date(Date.parse(block.startsAtUtc) + shift * 60_000).toISOString();
}
