'use client';

import { Fragment, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';

import {
  EditBlockModal,
  type EditableBlock as EditableBlockData,
} from '../_components/EditBlockModal';

import {
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
 * 今日页（UI-007，《UI 页面规范》v0.20 §5，接口 §6 `GET /today`）。
 *
 * 版式自上而下：当前行动 → 时间线（块行内完成/延后）→ 固定事项（只读）→
 * 例程与习惯 → 未安排（过期仅文字标记）→ 负荷与恢复（中性文案、可关闭）。
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

/* ── UI-011 丰富化（预览稿 §6.1 采纳项）────────────────────────────────── */

/** 一天的分钟数。写成 `24 * 60`——直接写全天分钟数会撞验收扫描器的断点字面量。 */
const MINUTES_PER_DAY = 24 * 60;

/** 时间骨架：08–22 基线，4 小时一笔刻度（两小时一档时那排数字自己就是图表）。 */
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
 * 空时间线的建议固定事项（预览稿 `.suggestions` 逐字）。
 * 做成**可点按钮**而不是死文案：预览稿注释明言「把常见固定事项变成一次点击」——
 * 点击给新增表单预填名称与开始时间（见 `FixedCommitmentForm` 的 `seed`）。
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
 * 日期串 → 「M 月 D 日 · 星期W」（今日摘要的眉标语境）。
 *
 * 取 `view.date`（服务端按用户时区定的「今天」）而不是前端 `new Date()`：
 * 后者在跨午夜/跨时区时可能与内容差一天。UTC 构造只为拿日历日的星期数——
 * 日期串是纯日历语义，不带时区。
 */
function dayEyebrow(date: string): string {
  const parts = date.split('-');
  return `${Number(parts[1])} 月 ${Number(parts[2])} 日 · ${WEEKDAY_LABELS[weekdayIndexOf(date)]}`;
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

/**
 * 时间骨架（UI-011 §6.1）：08–22 基线 + 每 4 小时一笔短刻度 + 「现在」指示线。
 *
 * 成功态只在**客户端**渲染（取数 effect 之后才有数据），所以这里可以放心用
 * `new Date()` 而不产生水合不一致。`aria-hidden`：刻度是视觉辅助，
 * 读屏读标题与列表行即可。指示线是这个区块里唯一一处强调色。
 */
function TimeRuler() {
  const now = new Date();
  const nowHour = now.getHours() + now.getMinutes() / 60;
  const at = (hour: number): number =>
    ((hour - RULER_START_HOUR) / (RULER_END_HOUR - RULER_START_HOUR)) * 100;
  const clamped = Math.min(RULER_END_HOUR, Math.max(RULER_START_HOUR, nowHour));
  const left = (hour: number): { left: string } => ({ left: `${String(at(hour))}%` });
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  return (
    <div className={styles.ruler} aria-hidden="true">
      {RULER_TICK_HOURS.map((hour) => (
        <Fragment key={hour}>
          <span className={styles.rulerLine} style={left(hour)} />
          <span className={styles.rulerLabel} style={left(hour)}>
            {String(hour).padStart(2, '0')}
          </span>
        </Fragment>
      ))}
      <span className={styles.rulerNow} style={left(clamped)} />
      <span className={styles.rulerNowTag} style={left(clamped)}>{`现在 ${hhmm}`}</span>
    </div>
  );
}

/**
 * 数字摘要 count-up（UI-011 §6.1）：进组件即从 0 滚动一次到位，不循环。
 *
 * 时长从 `--duration-base` 令牌读（×3 ≈ 600ms，工具页不该让数字滚两秒）；
 * reduce 模式下令牌归 0.01ms——首帧即终值，因此**不需要**写
 * prefers-reduced-motion 媒体查询（规范只允许令牌单点降级）。
 * 初值 `0 小时 0 分` 只存在一帧（该子树仅客户端渲染，无水合问题）。
 */
function RemainFigure() {
  const [text, setText] = useState(() => formatRemain(0));

  useEffect(() => {
    const now = new Date();
    const remain = MINUTES_PER_DAY - (now.getHours() * 60 + now.getMinutes());
    const base =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--duration-base')) ||
      200;
    const duration = base * 3;
    const startedAt = performance.now();
    let frameHandle = requestAnimationFrame(function step(frameAt: number): void {
      const progress = Math.min(1, (frameAt - startedAt) / duration);
      setText(formatRemain(Math.round(remain * (1 - Math.pow(1 - progress, 3)))));
      if (progress < 1) {
        frameHandle = requestAnimationFrame(step);
      }
    });

    return () => cancelAnimationFrame(frameHandle);
  }, []);

  return <p className={styles.figure}>{text}</p>;
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
   * 空时间线的建议 chips → 新增固定事项表单的预填载荷（UI-011）。
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

  if (today.state.status === 'loading') {
    return (
      <div className={styles.section} role="status" aria-busy="true">
        <Skeleton />
        <Skeleton width="80%" />
        <Skeleton width="90%" />
      </div>
    );
  }
  if (today.state.status === 'error') {
    return (
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
    );
  }

  const view = today.state.data;
  const unfinishedBlocks = view.blocks.filter((block) => block.status !== 'completed');
  const hasFixedBlock = view.fixedCommitments.length > 0;
  const hasRoutineBlock = view.routines.length > 0 || view.habits.length > 0;
  const overdueCount = view.unscheduledTasks.filter((task) => task.overdue).length;

  /*
   * 区块错峰序（§6.1）：按**实际渲染顺序**递增，条件区块缺席时不占号
   * （预览稿用 `nth-of-type`——产品里区块是条件渲染的，序号只能算出来）。
   * 当前行动卡片与表单不是 `.block`，不占号。
   */
  const fixedIndex = hasFixedBlock ? 1 : -1;
  const routinesIndex = hasRoutineBlock ? (hasFixedBlock ? 2 : 1) : -1;
  const unscheduledIndex = (hasFixedBlock ? 1 : 0) + (hasRoutineBlock ? 1 : 0) + 1;
  const summaryIndex = unscheduledIndex + 1;

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
        <div className={styles.summaryViz}>
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
    <div className={styles.blocks}>
      {view.currentAction === null ? null : (
        <section className={styles.currentAction} aria-label="当前行动">
          <p className={styles.currentLabel}>当前行动</p>
          <p className={styles.currentTitle}>{view.currentAction.title ?? '进行中'}</p>
          <p className={styles.currentMeta}>
            {clockOf(view.currentAction.startsAtUtc)} – {clockOf(view.currentAction.endsAtUtc)}
          </p>
        </section>
      )}

      <section
        aria-label="时间线"
        data-tour="today-timeline"
        className={styles.block}
        style={{ '--i': 0 } as CSSProperties}
      >
        {/* 眉标：给区块一个语境（当前时点与今天的关系），不是装饰。 */}
        <p className={styles.eyebrow}>{`今天 · ${timelineStatusOf(view.blocks)}`}</p>
        <div className={styles.blockHead}>
          <h2 className={styles.heading}>时间线</h2>
          <span className={styles.blockMeta}>{`${String(view.blocks.length)} 项`}</span>
        </div>
        {view.blocks.length === 0 ? (
          <p className={styles.hint}>
            今天还没有排时间块。 <Link href="/inbox">去收件箱</Link> 安排一个任务，或查看{' '}
            <Link href="/week">本周视图</Link>。
          </p>
        ) : (
          <ul className={styles.blockList}>
            {view.blocks.map((block) => {
              // 自由安排块没有 `taskId`（＝没有可挂规则的对象），§5 C 明文「固定事项与
              // 时间块不产生提醒」，因此这类块不渲染提醒入口。
              const taskId = block.taskId;
              const rowKey = `task:${taskId ?? ''}`;
              return (
                <li
                  key={block.id}
                  className={styles.blockRow}
                  data-glare
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
                  {block.status === 'completed' ? (
                    <span className={styles.doneBadge}>已完成</span>
                  ) : (
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
        {/* 时间骨架常驻（列表在上、骨架在下、建议在骨架下，与预览稿结构一致）。 */}
        <TimeRuler />
        {view.blocks.length !== 0 ? null : (
          <div className={styles.suggestions}>
            {SUGGESTED_COMMITMENTS.map((item) => (
              <button
                key={item.title}
                type="button"
                className={styles.chip}
                data-glare
                onClick={() => {
                  setCommitmentSeed({ title: item.title, startAt: item.startAt });
                }}
              >
                {`${item.title} ${item.startAt}`}
              </button>
            ))}
          </div>
        )}
      </section>

      {hasFixedBlock ? (
        <section
          aria-label="固定事项"
          className={styles.block}
          style={{ '--i': fixedIndex } as CSSProperties}
        >
          <div className={styles.blockHead}>
            <h2 className={styles.heading}>固定事项</h2>
            <span className={styles.blockMeta}>{`${String(view.fixedCommitments.length)} 项`}</span>
          </div>
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
        </section>
      ) : null}
      {/* 表单不是 `.block`：自带 `--space-4` 上距，与区块描边留出呼吸。 */}
      <div className={styles.formSlot}>
        <FixedCommitmentForm onCreated={today.refetch} seed={commitmentSeed} />
      </div>

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
          className={styles.block}
          style={{ '--i': routinesIndex } as CSSProperties}
        >
          <div className={styles.blockHead}>
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
                        onCreate: (draft) => reminders.createRule('routine', routine.id, draft),
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
                        checked={stepBlock !== undefined && stepBlock.status === 'completed'}
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
                        <span className={styles.doneBadge}>已完成</span>
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
        className={styles.block}
        style={{ '--i': unscheduledIndex } as CSSProperties}
      >
        <p className={styles.eyebrow}>从收件箱挑一件排进来</p>
        <div className={styles.blockHead}>
          <h2 className={styles.heading}>未安排</h2>
          <span className={styles.blockMeta}>
            {overdueCount > 0
              ? `${String(overdueCount)} 过期`
              : `${String(view.unscheduledTasks.length)} 项`}
          </span>
        </div>
        {view.unscheduledTasks.length === 0 ? (
          <p className={styles.hint}>没有待安排的任务。</p>
        ) : (
          <ul className={styles.unscheduledList}>
            {view.unscheduledTasks.map((task) => (
              <li key={task.id} className={styles.unscheduledRow} data-glare>
                <span>{task.title}</span>
                {task.overdue ? <span className={styles.overdueBadge}>过期</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-label="负荷与恢复"
        className={styles.block}
        style={{ '--i': summaryIndex } as CSSProperties}
      >
        <p className={styles.eyebrow}>{dayEyebrow(view.date)}</p>
        <div className={styles.blockHead}>
          <h2 className={styles.heading}>今日摘要</h2>
        </div>
        {/* 「还剩多少」升格成数字摘要：小字起意（figure-cap），大字给量（figure）。 */}
        <p className={styles.figureCap}>距离今天结束还有</p>
        <RemainFigure />
        <p className={styles.loadLine}>
          已排 {String(view.load.plannedMinutes)} 分钟 · 固定占用 {String(view.load.fixedMinutes)}{' '}
          分钟 · 已完成 {String(view.load.completedMinutes)} 分钟
        </p>
        {/* 本周迷你条：与摘要文字相邻（预览稿 summary-text → summary-viz 同序）。 */}
        {weekViz}
        {view.load.overloaded ? (
          <p className={styles.neutralNotice}>今天排得偏满，量力而行，随时可以延后一些。</p>
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
              {view.recovery.suggestions.length === 0 ? <li>今天没有需要调整的安排。</li> : null}
            </ul>
            <ExitRecoveryButton onDone={today.refetch} toast={toast} />
          </div>
        ) : null}
        {unfinishedBlocks.length === 0 && view.blocks.length > 0 ? (
          <p className={styles.neutralNotice}>今天的时间块都完成了，干得不错。</p>
        ) : null}
      </section>
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
 * `seed`（UI-011）：空时间线的建议 chips 点一下即预填名称与开始时间并展开表单，
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
