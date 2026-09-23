'use client';

import { Fragment, useState } from 'react';
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
  Skeleton,
  useAsyncQuery,
  useToast,
} from '@/shared/ui/components';

import { ApiRequestError, fetchJson, sendJson } from '../_lib/api-client';
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

export function TodayPanel() {
  const today = useAsyncQuery({
    queryKey: ['today'],
    queryFn: (signal) =>
      fetchJson<TodayView>(
        `/api/v1/today?timezone=${encodeURIComponent(localTimeZone())}`,
        signal,
      ).then((envelope) => envelope.data),
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

  return (
    <div className={styles.section}>
      {view.currentAction === null ? null : (
        <section className={styles.currentAction} aria-label="当前行动">
          <p className={styles.currentLabel}>当前行动</p>
          <p className={styles.currentTitle}>{view.currentAction.title ?? '进行中'}</p>
          <p className={styles.currentMeta}>
            {clockOf(view.currentAction.startsAtUtc)} – {clockOf(view.currentAction.endsAtUtc)}
          </p>
        </section>
      )}

      <section aria-label="时间线">
        <h2 className={styles.heading}>时间线</h2>
        {view.blocks.length === 0 ? (
          <p className={styles.hint}>
            今天还没有排时间块。 <Link href="/inbox">去收件箱</Link> 安排一个任务，或查看{' '}
            <Link href="/week">本周视图</Link>。
          </p>
        ) : (
          <ul className={styles.blockList}>
            {view.blocks.map((block) => (
              <li
                key={block.id}
                className={styles.blockRow}
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
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.fixedCommitments.length === 0 ? null : (
        <section aria-label="固定事项">
          <h2 className={styles.heading}>固定事项</h2>
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
      )}
      <FixedCommitmentForm onCreated={today.refetch} />

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

      {view.routines.length === 0 && view.habits.length === 0 ? null : (
        <section aria-label="例程与习惯">
          <h2 className={styles.heading}>例程与习惯</h2>
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
      )}

      <section aria-label="未安排">
        <h2 className={styles.heading}>未安排</h2>
        {view.unscheduledTasks.length === 0 ? (
          <p className={styles.hint}>没有待安排的任务。</p>
        ) : (
          <ul className={styles.unscheduledList}>
            {view.unscheduledTasks.map((task) => (
              <li key={task.id} className={styles.unscheduledRow}>
                <span>{task.title}</span>
                {task.overdue ? <span className={styles.overdueBadge}>过期</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="负荷与恢复">
        <h2 className={styles.heading}>今日摘要</h2>
        <p className={styles.loadLine}>
          已排 {String(view.load.plannedMinutes)} 分钟 · 固定占用 {String(view.load.fixedMinutes)}{' '}
          分钟 · 已完成 {String(view.load.completedMinutes)} 分钟
        </p>
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
 */
function FixedCommitmentForm({ onCreated }: { readonly onCreated: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [startAtLocal, setStartAtLocal] = useState('09:00');
  const [durationMinutes, setDurationMinutes] = useState('60');
  const [saving, setSaving] = useState(false);

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
