'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, ErrorState, Skeleton, useAsyncQuery } from '@/shared/ui/components';

import { fetchJson } from '../_lib/api-client';
import { fetchProfile } from '../_lib/identity-api';
import { addDays, formatWeekRange, localCalendarDay, startOfWeek } from '../_lib/review-api';
import { EditBlockModal, type EditableBlock } from '../_components/EditBlockModal';
import styles from './WeekPanel.module.css';

/**
 * 周视图（SCHED-003 P0 最小集，UI v0.20 冻结：只读七日网格）。
 *
 * 数据源＝`GET /schedule-blocks` 周窗口（固定事项同形态叠入）；
 * 不做周内拖拽（P0 冻结明确），点击块跳到编辑弹层属后续批次的
 * 「点击替代」——本页先交付只读网格与导航。
 *
 * ## 任意一周（REVIEW-003 增量）
 *
 * 原先本页只渲染"现在这一周"。复盘页 B2 第 7 项的固定链接「查看下周计划」
 * （UI 规范 v0.21 §5 B4）要指向**下一周**，本页因此支持 `?weekStart=YYYY-MM-DD`：
 * 服务端读出该参数经 `requestedWeekStart` 传入，页面按用户的 `weekStartsOn`
 * 对齐到所在周起点后渲染该周七天，并提供「上一周 / 本周」按钮组（与 B2 同型）。
 *
 * 参数**不做错误态**：非法或缺失一律回落本周——本页是只读视图，用一个坏参数
 * 把整页打成错误态，比静默显示本周更糟，且用户没有可修的东西。
 */
interface WindowBlock {
  readonly id: string;
  readonly taskId: string | null;
  readonly title: string | null;
  readonly startsAtUtc: string;
  readonly endsAtUtc: string;
  readonly status: string;
  readonly version: number;
}

interface WindowFixed {
  readonly id: string;
  readonly title: string;
  readonly startsAtUtc: string | null;
}

/** 用户设置未到达时的默认周起点（周一，与 DB `period_key`「该周周一」口径一致）。 */
const DEFAULT_WEEK_STARTS_ON = 1;

/** `?weekStart=` 接受的形状；其余一律视为"没给"。 */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function clockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
}

/** 自 `weekStart` 起的 7 个日历日（本地时区语义由服务端按 timezone 解释）。 */
function weekDaysFrom(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

export function WeekPanel({ requestedWeekStart }: { readonly requestedWeekStart: string }) {
  // 周视图 P0＝只读展示＋点击块编辑（任务清单次级口径⑨冻结）。
  const [editing, setEditing] = useState<EditableBlock | null>(null);
  const router = useRouter();

  const profile = useAsyncQuery({ queryKey: ['me'], queryFn: fetchProfile });
  const weekStartsOn =
    profile.state.status === 'success'
      ? profile.state.data.data.weekStartsOn
      : DEFAULT_WEEK_STARTS_ON;

  // 跨午夜开着页面不刷新属可接受行为（与 `queries.ts` 的 TODAY 同一取舍）。
  const thisWeekStart = startOfWeek(localCalendarDay(), weekStartsOn);
  const weekStart = CALENDAR_DAY.test(requestedWeekStart)
    ? startOfWeek(requestedWeekStart, weekStartsOn)
    : thisWeekStart;
  const weekEnd = addDays(weekStart, 6);
  const days = weekDaysFrom(weekStart);

  const week = useAsyncQuery({
    queryKey: ['schedule-blocks', 'week', weekStart],
    queryFn: async (signal) => {
      const from = weekStart;
      const to = weekEnd;
      const timezone = localTimeZone();
      const blocks = await fetchJson<{ readonly items: readonly WindowBlock[] }>(
        `/api/v1/schedule-blocks?from=${from}&to=${to}&timezone=${encodeURIComponent(timezone)}`,
        signal,
      ).then((envelope) => envelope.data.items);
      const fixed = await fetchJson<{ readonly items: readonly WindowFixed[] }>(
        `/api/v1/fixed-commitments?from=${from}&to=${to}&timezone=${encodeURIComponent(timezone)}`,
        signal,
      ).then((envelope) => envelope.data.items);
      return { blocks, fixed };
    },
  });

  // 取数结果在 JSX 之外先收敛成 `null | 数据`：三元链里直接写 `week.state.data`
  // 会因闭包（`EditBlockModal` 的回调）丢掉判别式收窄，编译器会把三态当成联合访问。
  const weekData = week.state.status === 'success' ? week.state.data : null;

  /**
   * 切到某一周。
   *
   * 用 `replace` 而不是 `push`：周切换是**视图筛选**，不是一次导航目的地——用 push
   * 的话，用户逐周回看几屏之后，浏览器后退键要按十几次才出得去，而中间没有一站是
   * 用户想去的地方。「本周」回到不带参数的干净地址。
   */
  const goToWeek = (target: string) => {
    router.replace(target === thisWeekStart ? '/week' : `/week?weekStart=${target}`);
  };

  return (
    <div className={styles.section}>
      <div className={styles.weekNav}>
        <Button
          variant="ghost"
          onClick={() => {
            goToWeek(addDays(weekStart, -7));
          }}
        >
          上一周
        </Button>
        <Button
          variant="ghost"
          aria-pressed={weekStart === thisWeekStart}
          onClick={() => {
            goToWeek(thisWeekStart);
          }}
        >
          本周
        </Button>
        <p className={styles.range}>{formatWeekRange(weekStart)}</p>
      </div>

      {week.state.status === 'loading' ? (
        <div className={styles.section}>
          <Skeleton />
          <Skeleton width="70%" />
        </div>
      ) : null}
      {week.state.status === 'error' ? (
        <ErrorState
          title="这周的安排没能加载"
          description="数据没能取回来。可以先重试。"
          action={
            <Button variant="primary" onClick={week.refetch}>
              重试
            </Button>
          }
        />
      ) : null}
      {weekData === null ? null : (
        <>
          {editing === null ? null : (
            <EditBlockModal
              block={editing}
              onClose={() => {
                setEditing(null);
              }}
              onSaved={() => {
                setEditing(null);
                week.refetch();
              }}
            />
          )}
          <div className={styles.grid}>
            {days.map((day) => {
              const dayBlocks = weekData.blocks.filter((block) =>
                dayMatches(block.startsAtUtc, day),
              );
              const dayFixed = weekData.fixed.filter((item) =>
                item.startsAtUtc === null ? false : dayMatches(item.startsAtUtc, day),
              );
              return (
                <section key={day} className={styles.dayColumn} aria-label={day}>
                  <h2 className={styles.dayHeading}>{dayLabel(`${day}T00:00:00`)}</h2>
                  {dayFixed.map((item) => (
                    <p key={item.id} className={styles.fixedItem}>
                      {item.startsAtUtc === null ? '' : `${clockOf(item.startsAtUtc)} `}
                      {item.title}
                    </p>
                  ))}
                  {dayBlocks.length === 0 && dayFixed.length === 0 ? (
                    <p className={styles.emptyDay}>—</p>
                  ) : null}
                  {dayBlocks.map((block) => (
                    <button
                      key={block.id}
                      type="button"
                      className={
                        block.status === 'completed' ? styles.completedItem : styles.blockItem
                      }
                      onClick={() => {
                        if (block.status !== 'completed') {
                          setEditing(block);
                        }
                      }}
                    >
                      {clockOf(block.startsAtUtc)} {block.title ?? '自由安排'}
                    </button>
                  ))}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** 块的 UTC 瞬时落在该日历日（本地时区近似——窗口物化已在服务端按日解释）。 */
function dayMatches(iso: string, day: string): boolean {
  const local = new Date(iso);
  const month = String(local.getMonth() + 1).padStart(2, '0');
  const date = String(local.getDate()).padStart(2, '0');
  return `${String(local.getFullYear())}-${month}-${date}` === day;
}
