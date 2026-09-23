'use client';

import { useState } from 'react';

import { Button, ErrorState, Skeleton, useAsyncQuery } from '@/shared/ui/components';

import { fetchJson } from '../_lib/api-client';
import { EditBlockModal, type EditableBlock } from '../_components/EditBlockModal';
import styles from './WeekPanel.module.css';

/**
 * 周视图（SCHED-003 P0 最小集，UI v0.20 冻结：只读七日网格）。
 *
 * 数据源＝`GET /schedule-blocks` 周窗口（固定事项同形态叠入）；
 * 不做周内拖拽（P0 冻结明确），点击块跳到编辑弹层属后续批次的
 * 「点击替代」——本页先交付只读网格与导航。
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

/** 本周从周一开始的 7 个日历日（本地时区语义由服务端按 timezone 解释）。 */
function weekDays(): string[] {
  const now = new Date();
  const shift = (now.getDay() + 6) % 7; // 周一为 0
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - shift);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index);
    const month = String(day.getMonth() + 1).padStart(2, '0');
    const date = String(day.getDate()).padStart(2, '0');
    return `${String(day.getFullYear())}-${month}-${date}`;
  });
}

export function WeekPanel() {
  // 周视图 P0＝只读展示＋点击块编辑（任务清单次级口径⑨冻结）。
  const [editing, setEditing] = useState<EditableBlock | null>(null);
  const [days] = useState<string[]>(weekDays);
  const week = useAsyncQuery({
    queryKey: ['schedule-blocks', 'week', days[0] ?? ''],
    queryFn: async (signal) => {
      const from = days[0] ?? '';
      const to = days[days.length - 1] ?? '';
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

  if (week.state.status === 'loading') {
    return (
      <div className={styles.section}>
        <Skeleton />
        <Skeleton width="70%" />
      </div>
    );
  }
  if (week.state.status === 'error') {
    return (
      <ErrorState
        title="本周安排没能加载"
        description="数据没能取回来。可以先重试。"
        action={
          <Button variant="primary" onClick={week.refetch}>
            重试
          </Button>
        }
      />
    );
  }

  const { blocks, fixed } = week.state.data;

  return (
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
          const dayBlocks = blocks.filter((block) => dayMatches(block.startsAtUtc, day));
          const dayFixed = fixed.filter((item) =>
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
                  className={block.status === 'completed' ? styles.completedItem : styles.blockItem}
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
  );
}

/** 块的 UTC 瞬时落在该日历日（本地时区近似——窗口物化已在服务端按日解释）。 */
function dayMatches(iso: string, day: string): boolean {
  const local = new Date(iso);
  const month = String(local.getMonth() + 1).padStart(2, '0');
  const date = String(local.getDate()).padStart(2, '0');
  return `${String(local.getFullYear())}-${month}-${date}` === day;
}
