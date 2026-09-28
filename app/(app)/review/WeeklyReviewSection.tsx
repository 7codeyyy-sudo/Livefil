'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import {
  Badge,
  Button,
  ErrorState,
  Select,
  Skeleton,
  useAsyncQuery,
  useOnlineStatus,
  useToast,
} from '@/shared/ui/components';
import type { AsyncQueryState } from '@/shared/ui/components';

import { formatMinorToHuman } from '../_lib/expense-api';
import { fetchProfile } from '../_lib/identity-api';
import {
  ADJUSTMENT_LABELS,
  addDays,
  createReviewAdjustment,
  fetchExpenseSummaryByLifeArea,
  fetchWeekTasks,
  fetchWeeklyReview,
  formatMinutes,
  formatSignedMinutes,
  formatWeekRange,
  localCalendarDay,
  nextWeekDueDate,
  startOfWeek,
  weekEndInclusive,
} from '../_lib/review-api';
import type {
  AdjustmentAction,
  AdjustmentTargetType,
  ExpenseSummaryData,
  ReviewAdjustmentItem,
  WeekTaskItem,
  WeeklyReviewItem,
} from '../_lib/review-api';

import { AdjustmentConfirmDialog } from './AdjustmentConfirmDialog';
import type { PendingAdjustment } from './AdjustmentConfirmDialog';

import styles from './WeeklyReviewSection.module.css';

/** 库默认周起点（周一）——`/me` 尚未取回时用它，取回后按用户设置重算。 */
const DEFAULT_WEEK_STARTS_ON = 1;

/** 任务类洞察的四个动作（B3；「暂停目标」只属目标类）。 */
const TASK_ACTIONS: readonly AdjustmentAction[] = ['keep', 'shorten', 'defer', 'delete'];
/** 目标类洞察的两个动作（B3）。 */
const GOAL_ACTIONS: readonly AdjustmentAction[] = ['keep', 'pause'];

/** 一个可被调整的候选对象（洞察行展开后由用户选定，或在只有一个候选时直接使用）。 */
interface AdjustmentCandidate {
  readonly id: string;
  readonly name: string;
  readonly estimatedMinutes: number | null;
  readonly dueDate: string | null;
}

/** 补充数据（按生活领域的开销）的取数结果形状——只透传它需要的两部分。 */
interface LifeAreaQueryResult {
  readonly state: AsyncQueryState<ExpenseSummaryData>;
  readonly refetch: () => void;
}

/** 一条洞察（B3：命中才显示，全不命中则整段不渲染）。 */
interface InsightRow {
  readonly key: string;
  readonly text: string;
  readonly targetType: AdjustmentTargetType;
  readonly actions: readonly AdjustmentAction[];
  readonly candidates: readonly AdjustmentCandidate[];
  /** 候选集来源的说明行（口径如实，不给用户一个"猜"的余地）。 */
  readonly hint: string | null;
}

/**
 * 周复盘（《UI 页面规范》§5 B2~B4，REVIEW-002/003）。
 *
 * ## 三段严格按「看到事实 → 理解偏差 → 做出调整」排序（B0）
 *
 * 第 1~6 项在「事实」段、洞察在「偏差」段、调整清单在「调整」段。段落顺序写在
 * JSX 结构里而不是靠样式排序——顺序是产品语义，样式表不该是它的唯一载体。
 *
 * ## 三条数据各自取、各自容错
 *
 * 主数据（`GET /reviews/weekly/{weekStart}`）失败才使整段落错误态；两条**补充**
 * 数据（按生活领域的开销、周窗口内的任务）失败只影响自己那一小块（各给一行
 * 说明 + 重试），否则一条辅助请求失败会让整页看起来"坏了"。周起点来自 `/me`，
 * 取不到时按库默认（周一）算——它是显示口径，不阻塞主数据的呈现。
 *
 * ## 提交成功后为什么不自动重取
 *
 * 取数原语没有缓存，`refetch()` 会把状态推回 loading，整段七项会闪一次骨架；
 * 而 B4 只要求「该动作即时入列」——入列数据直接取 POST 的返回（接口 §10 返回
 * 入列后的完整清单）。已执行的副作用（如缩短后的计划时长）在下次进入/切换周时
 * 与服务端对齐，这个取舍写在交付报告里。
 */
export function WeeklyReviewSection() {
  const router = useRouter();
  const toast = useToast();
  const online = useOnlineStatus();

  const [weekOffset, setWeekOffset] = useState(0);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAdjustment | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [posted, setPosted] = useState<{
    readonly week: string;
    readonly items: readonly ReviewAdjustmentItem[];
  } | null>(null);

  // 跨午夜开着页面不刷新属可接受行为（与 `queries.ts` 的 TODAY 同一取舍）。
  const today = localCalendarDay();

  const profile = useAsyncQuery({ queryKey: ['me'], queryFn: fetchProfile });
  const weekStartsOn =
    profile.state.status === 'success'
      ? profile.state.data.data.weekStartsOn
      : DEFAULT_WEEK_STARTS_ON;

  // 本周起点按用户 `weekStartsOn` 算；「上一周」只移动偏移量，不冻结具体日期——
  // 否则用户改了周起点设置后，那两个按钮会指向按旧口径算出的周。
  const weekStart = addDays(startOfWeek(today, weekStartsOn), weekOffset * 7);
  const weekEnd = weekEndInclusive(weekStart);

  const weekly = useAsyncQuery({
    queryKey: ['reviews', 'weekly', weekStart],
    queryFn: (signal) => fetchWeeklyReview(weekStart, signal),
  });
  const lifeArea = useAsyncQuery({
    queryKey: ['expense-summary', 'lifeArea', weekStart],
    queryFn: (signal) => fetchExpenseSummaryByLifeArea(weekStart, weekEnd, signal),
  });
  const weekTasks = useAsyncQuery({
    queryKey: ['tasks', 'week', weekStart],
    queryFn: (signal) => fetchWeekTasks(weekStart, weekEnd, signal),
  });

  const data = weekly.state.status === 'success' ? weekly.state.data : null;
  const tasks = weekTasks.state.status === 'success' ? weekTasks.state.data : null;

  const submit = async (payload: Readonly<Record<string, unknown>>) => {
    if (pending === null) {
      return;
    }
    setSubmitting(true);
    setDialogError(null);
    try {
      const envelope = await createReviewAdjustment(weekStart, {
        targetType: pending.targetType,
        targetId: pending.targetId,
        action: pending.action,
        payload,
      });
      setPosted({ week: weekStart, items: envelope.data.adjustments });
      setPending(null);
      toast.success('已记录调整', {
        action: { label: '查看下周计划', onClick: () => router.push('/week') },
      });
    } catch (error) {
      // 含「离线提交调整不支持」（披露 B.7 已声明）：失败就地呈现，不关弹窗。
      setDialogError(error instanceof Error ? error.message : '提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.weekNav}>
        <Button
          variant="ghost"
          onClick={() => {
            setWeekOffset((current) => current - 1);
          }}
        >
          上一周
        </Button>
        <Button
          variant="ghost"
          aria-pressed={weekOffset === 0}
          onClick={() => {
            setWeekOffset(0);
          }}
        >
          本周
        </Button>
        <p className={styles.range}>{formatWeekRange(weekStart)}</p>
      </div>

      {weekly.state.status === 'loading' ? (
        <div className={styles.skeleton}>
          <Skeleton />
          <Skeleton width="80%" />
          <Skeleton width="90%" />
          <Skeleton width="70%" />
          <Skeleton width="85%" />
          <Skeleton width="60%" />
          <Skeleton width="75%" />
        </div>
      ) : null}

      {weekly.state.status === 'error' ? (
        <ErrorState
          title="周复盘没能加载"
          description="这一周的汇总数据没能取回来。可以先重试。"
          action={
            <Button variant="primary" onClick={weekly.refetch}>
              重试
            </Button>
          }
        />
      ) : null}

      {data === null ? null : (
        <>
          <FactsSection data={data} weekStart={weekStart} weekEnd={weekEnd} lifeArea={lifeArea} />

          <HeadlineSection
            data={data}
            tasks={tasks}
            tasksFailed={weekTasks.state.status === 'error'}
            onRetryTasks={weekTasks.refetch}
            expandedKey={expandedKey}
            onToggle={(key) => {
              setExpandedKey((current) => (current === key ? null : key));
            }}
            onPick={(action, candidate, targetType) => {
              setDialogError(null);
              setPending({
                action,
                targetType,
                targetId: candidate.id,
                targetName: candidate.name,
                currentEstimatedMinutes: candidate.estimatedMinutes,
                deferDueDate: nextWeekDueDate(weekStart, candidate.dueDate),
              });
            }}
          />

          <AdjustmentsSection
            adjustments={
              posted !== null && posted.week === weekStart ? posted.items : data.adjustments
            }
            taskNames={collectTaskNames(data, tasks)}
            goalNames={collectGoalNames(data)}
          />
        </>
      )}

      {pending === null ? null : (
        <AdjustmentConfirmDialog
          // 换动作/换目标＝换一个实例，数值输入与错误行随之重来（见组件说明）。
          key={`${pending.action}:${pending.targetId}`}
          pending={pending}
          submitting={submitting}
          errorMessage={dialogError}
          offline={!online}
          onCancel={() => {
            setPending(null);
            setDialogError(null);
          }}
          onConfirm={submit}
        />
      )}
    </div>
  );
}

/** 「事实」段：B2 第 1~6 项。 */
function FactsSection({
  data,
  weekStart,
  weekEnd,
  lifeArea,
}: {
  readonly data: WeeklyReviewItem;
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly lifeArea: LifeAreaQueryResult;
}) {
  const counts = data.taskStatusCounts;
  const plannedTotal = counts.completed + counts.partial + counts.deferred + counts.skipped;
  const variance = data.planActual.actualMinutes - data.planActual.plannedMinutes;

  return (
    <section className={styles.block} aria-label="本周事实">
      <h3 className={styles.blockTitle}>本周事实</h3>

      {/* 第 1 项：本周计划任务数（「状态总览行」与第 2 项同源，合并为同一行四枚
          Badge——同一事实两处各写一份口径是漂移的起点）。 */}
      <p className={styles.metricValue}>本周计划任务 {plannedTotal} 个</p>
      <div className={styles.counts}>
        <Badge variant="neutral">完成 {counts.completed}</Badge>
        <Badge variant="neutral">部分完成 {counts.partial}</Badge>
        <Badge variant="neutral">跳过 {counts.skipped}</Badge>
        <Badge variant="neutral">延期 {counts.deferred}</Badge>
      </div>

      {/* 第 3 项：计划 / 实际 / 差值三列数值对照（不做图）。 */}
      <div className={styles.metrics}>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>计划</span>
          <span className={styles.metricValue}>
            {formatMinutes(data.planActual.plannedMinutes)}
          </span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>实际</span>
          <span className={styles.metricValue}>{formatMinutes(data.planActual.actualMinutes)}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>差值</span>
          <span className={styles.metricValue}>{formatSignedMinutes(variance)}</span>
        </div>
      </div>
      <p className={styles.hint}>实际时长只计已执行的任务（未执行不计入对比）。</p>

      {/* 第 4 项：重复延期任务（无命中给行文案，不升 EmptyState 容器）。 */}
      <p className={styles.subLabel}>重复延期任务</p>
      {data.repeatedDeferrals.length === 0 ? (
        <p className={styles.hint}>本周没有重复延期的任务</p>
      ) : (
        <div className={styles.rows}>
          {data.repeatedDeferrals.map((item) => (
            <p key={item.taskId} className={styles.rowText}>
              {item.title} · 本周改期 {item.deferCount} 次
            </p>
          ))}
        </div>
      )}

      {/* 第 5 项：目标行动完成情况。 */}
      <p className={styles.subLabel}>目标行动完成情况</p>
      {data.goalActions.length === 0 ? (
        <p className={styles.hint}>本周没有关联目标的行动</p>
      ) : (
        <div className={styles.rows}>
          {data.goalActions.map((item) => (
            <p key={item.goalId} className={styles.rowText}>
              {item.goalName} — 行动 {item.completed}/{item.total} 完成
            </p>
          ))}
        </div>
      )}

      {/* 第 6 项：开销三小块（周总额按币种分列 + 按分类 + 按生活领域）。 */}
      <ExpenseBlocks
        summaries={data.expenseSummaries}
        groups={lifeArea.state.status === 'success' ? lifeArea.state.data.groups : null}
        loadingGroups={lifeArea.state.status === 'loading'}
        groupsFailed={lifeArea.state.status === 'error'}
        onRetryGroups={lifeArea.refetch}
        range={`${weekStart} ~ ${weekEnd}`}
      />
    </section>
  );
}

/** B2 第 6 项的三小块。 */
function ExpenseBlocks({
  summaries,
  groups,
  loadingGroups,
  groupsFailed,
  onRetryGroups,
  range,
}: {
  readonly summaries: WeeklyReviewItem['expenseSummaries'];
  readonly groups: ExpenseSummaryData['groups'] | null;
  readonly loadingGroups: boolean;
  readonly groupsFailed: boolean;
  readonly onRetryGroups: () => void;
  readonly range: string;
}) {
  return (
    <div className={styles.subBlock}>
      <p className={styles.subLabel}>本周开销</p>

      {summaries.length === 0 ? (
        <p className={styles.hint}>本周没有开销记录</p>
      ) : (
        <>
          <div className={styles.metrics}>
            {summaries.map((summary) => (
              <div key={summary.currencyCode} className={styles.metric}>
                <span className={styles.metricLabel}>{summary.currencyCode} 合计</span>
                <span className={styles.metricValue}>{formatMinorToHuman(summary.totalMinor)}</span>
              </div>
            ))}
          </div>
          <p className={styles.hint}>按币种分列，不跨币种合计。</p>

          <p className={styles.hint}>按分类</p>
          <div className={styles.rows}>
            {summaries.flatMap((summary) => {
              if (summary.byCategory.length === 0) {
                return [
                  <p key={`${summary.currencyCode}-empty`} className={styles.hint}>
                    {summary.currencyCode}：本周没有分类支出
                  </p>,
                ];
              }
              return summary.byCategory.map((category) => (
                <p
                  key={`${summary.currencyCode}-${category.categoryId}`}
                  className={styles.rowText}
                >
                  {category.categoryName}
                  <span className={styles.amount}>
                    {summary.currencyCode} {formatMinorToHuman(category.totalMinor)}
                  </span>
                </p>
              ));
            })}
          </div>
        </>
      )}

      {/* 按生活领域：周复盘响应只承载「按分类」，这一块现取 `GET /expense-summary`
          （披露里已声明：过去周读的是查看时数据，不是该周结束时的数据）。 */}
      <p className={styles.hint}>按生活领域</p>
      {loadingGroups ? (
        <Skeleton width="55%" />
      ) : groupsFailed ? (
        <div className={styles.inlineError}>
          <p className={styles.error} role="alert">
            按生活领域的开销没能取回来。
          </p>
          <Button variant="ghost" onClick={onRetryGroups}>
            重试
          </Button>
        </div>
      ) : groups === null || groups.length === 0 ? (
        <p className={styles.hint}>本周没有按生活领域的开销记录</p>
      ) : (
        <div className={styles.rows}>
          {groups.map((group) => (
            <p key={group.key ?? 'unassigned'} className={styles.rowText}>
              {group.label}
              <span className={styles.amount}>
                {group.totals.map((total) => (
                  <span key={total.currencyCode}>
                    {total.currencyCode} {formatMinorToHuman(total.totalMinor)}
                  </span>
                ))}
              </span>
            </p>
          ))}
        </div>
      )}
      <p className={styles.hint}>统计区间 {range}。</p>
    </div>
  );
}

/** 「偏差」段：B3 洞察与就地操作（命中才显示；全不命中则整段不渲染）。 */
function HeadlineSection({
  data,
  tasks,
  tasksFailed,
  onRetryTasks,
  expandedKey,
  onToggle,
  onPick,
}: {
  readonly data: WeeklyReviewItem;
  readonly tasks: readonly WeekTaskItem[] | null;
  readonly tasksFailed: boolean;
  readonly onRetryTasks: () => void;
  readonly expandedKey: string | null;
  readonly onToggle: (key: string) => void;
  readonly onPick: (
    action: AdjustmentAction,
    candidate: AdjustmentCandidate,
    targetType: AdjustmentTargetType,
  ) => void;
}) {
  const rows = buildInsights(data, tasks, tasksFailed);

  if (rows.length === 0) {
    return null;
  }

  return (
    <section className={styles.block} aria-label="本周洞察">
      <h3 className={styles.blockTitle}>需要留意</h3>
      {rows.map((row) => (
        <div key={row.key} className={styles.insightRow}>
          <p className={styles.rowText}>{row.text}</p>
          {row.candidates.length === 0 ? (
            // 候选集取不到时不给「调整」按钮（点了也没有目标可选），
            // 改为说明 + 重试——比一个按下去没有反应的按钮诚实。
            <div className={styles.inlineError}>
              <p className={styles.hint}>{row.hint ?? '候选目标没能取回来。'}</p>
              <Button variant="ghost" onClick={onRetryTasks}>
                重试
              </Button>
            </div>
          ) : expandedKey === row.key ? (
            <div className={styles.expansion}>
              <InsightActions
                key={row.key}
                row={row}
                onPick={(action, candidate) => {
                  onPick(action, candidate, row.targetType);
                }}
              />
              <Button
                variant="ghost"
                onClick={() => {
                  onToggle(row.key);
                }}
              >
                收起
              </Button>
            </div>
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                onToggle(row.key);
              }}
            >
              调整
            </Button>
          )}
          {row.hint === null || row.candidates.length === 0 ? null : (
            <p className={styles.hint}>{row.hint}</p>
          )}
        </div>
      ))}
    </section>
  );
}

/** 一条洞察展开后的动作组：候选 >1 时先选目标，再选动作（组内全次按钮、不设主按钮）。 */
function InsightActions({
  row,
  onPick,
}: {
  readonly row: InsightRow;
  readonly onPick: (action: AdjustmentAction, candidate: AdjustmentCandidate) => void;
}) {
  const [selectedId, setSelectedId] = useState(row.candidates[0]?.id ?? '');
  const selected = row.candidates.find((item) => item.id === selectedId) ?? row.candidates[0];

  if (selected === undefined) {
    return null;
  }

  return (
    <>
      {row.candidates.length > 1 ? (
        <Select
          label="调整哪一项"
          value={selected.id}
          onChange={(event) => {
            setSelectedId(event.target.value);
          }}
        >
          {row.candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </Select>
      ) : null}

      <div className={styles.actions}>
        {row.actions.map((action) => (
          <Button
            key={action}
            variant="secondary"
            onClick={() => {
              onPick(action, selected);
            }}
          >
            {ADJUSTMENT_LABELS[action]}
          </Button>
        ))}
      </div>
    </>
  );
}

/** 「调整」段：B2 第 7 项 + B4 的可追溯清单。 */
function AdjustmentsSection({
  adjustments,
  taskNames,
  goalNames,
}: {
  readonly adjustments: readonly ReviewAdjustmentItem[];
  readonly taskNames: ReadonlyMap<string, string>;
  readonly goalNames: ReadonlyMap<string, string>;
}) {
  return (
    <section className={styles.block} aria-label="下周调整确认">
      <h3 className={styles.blockTitle}>下周调整确认</h3>

      {adjustments.length === 0 ? (
        <p className={styles.hint}>本周还没有调整动作——在上方洞察中选择</p>
      ) : (
        <div className={styles.rows}>
          {adjustments.map((item) => (
            <div key={item.id} className={styles.adjustItem}>
              <Badge variant="neutral">{ADJUSTMENT_LABELS[item.action]}</Badge>
              <span className={styles.rowText}>
                {resolveTargetName(item, taskNames, goalNames)}
              </span>
              <span className={styles.hint}>{describePayload(item)}</span>
              <span className={styles.hint}>{formatRecordedAt(item.createdAt)}</span>
            </div>
          ))}
        </div>
      )}

      <p className={styles.linkRow}>
        <Link href="/week">查看下周计划</Link>
      </p>
    </section>
  );
}

/**
 * B3 的三条洞察 → 行。
 *
 * 命中才产生行；一条都不命中时调用方不渲染整段。候选集与「对象」类型都按
 * 冻结文案写死在这里，而不是从数据里猜——猜错的后果是给一个目标类动作配上
 * 任务 id（服务端会以 422 挡下，但用户看到的是一次莫名其妙的失败）。
 */
function buildInsights(
  data: WeeklyReviewItem,
  tasks: readonly WeekTaskItem[] | null,
  tasksFailed: boolean,
): readonly InsightRow[] {
  const rows: InsightRow[] = [];

  // 洞察 1：重复延期（对象＝任务）。候选＝重复延期清单本身，名字已在响应里。
  if (data.repeatedDeferrals.length > 0) {
    rows.push({
      key: 'repeated-deferral',
      text: `本周有 ${String(data.repeatedDeferrals.length)} 个任务重复延期`,
      targetType: 'task',
      actions: TASK_ACTIONS,
      candidates: data.repeatedDeferrals.map((item) => ({
        id: item.taskId,
        name: `${item.title}（本周改期 ${String(item.deferCount)} 次）`,
        estimatedMinutes: findTask(tasks, item.taskId)?.estimatedMinutes ?? null,
        dueDate: findTask(tasks, item.taskId)?.dueDate ?? null,
      })),
      hint: null,
    });
  }

  // 洞察 2：计划任务未执行（对象＝任务）。计数＝延期 + 跳过（部分完成属"执行了
  // 但未完成"，不计入"未执行"）；周响应只给计数、不给清单，候选取本周计划任务。
  const unexecuted = data.taskStatusCounts.deferred + data.taskStatusCounts.skipped;
  if (unexecuted > 0) {
    rows.push({
      key: 'unexecuted-task',
      text: `${String(unexecuted)} 个计划任务未执行`,
      targetType: 'task',
      actions: TASK_ACTIONS,
      candidates: (tasks ?? []).map((task) => ({
        id: task.id,
        name: task.title,
        estimatedMinutes: task.estimatedMinutes,
        dueDate: task.dueDate,
      })),
      hint: tasksFailed
        ? '本周计划任务没能取回来，无法选择要调整的任务。'
        : '候选为本周计划任务（汇总只给计数，未执行清单不在契约内）。',
    });
  }

  // 洞察 3：某目标本周行动进展为 0/y（对象＝目标）。
  for (const goal of data.goalActions) {
    if (goal.completed === 0 && goal.total > 0) {
      rows.push({
        key: `goal-progress-${goal.goalId}`,
        text: `《${goal.goalName}》本周无行动进展`,
        targetType: 'goal',
        actions: GOAL_ACTIONS,
        candidates: [
          { id: goal.goalId, name: goal.goalName, estimatedMinutes: null, dueDate: null },
        ],
        hint: null,
      });
    }
  }

  return rows;
}

function findTask(tasks: readonly WeekTaskItem[] | null, taskId: string): WeekTaskItem | undefined {
  return tasks?.find((task) => task.id === taskId);
}

/** 调整清单里的目标名：先查本周任务与目标，再查延期清单（响应里自带标题），最后兜底短 id。 */
function resolveTargetName(
  item: ReviewAdjustmentItem,
  taskNames: ReadonlyMap<string, string>,
  goalNames: ReadonlyMap<string, string>,
): string {
  const names = item.targetType === 'task' ? taskNames : goalNames;
  return (
    names.get(item.targetId) ??
    `${item.targetType === 'task' ? '任务' : '目标'} ${item.targetId.slice(0, 8)}`
  );
}

/** 本周任务与目标的可读名（用于调整清单的目标名解析）。 */
function collectTaskNames(
  data: WeeklyReviewItem,
  tasks: readonly WeekTaskItem[] | null,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const item of data.repeatedDeferrals) {
    names.set(item.taskId, item.title);
  }
  for (const task of tasks ?? []) {
    names.set(task.id, task.title);
  }
  return names;
}

function collectGoalNames(data: WeeklyReviewItem): ReadonlyMap<string, string> {
  return new Map(data.goalActions.map((item) => [item.goalId, item.goalName]));
}

/** 动作的关键参数（B2 第 7 项：如「至 20 分钟」）。 */
function describePayload(item: ReviewAdjustmentItem): string {
  if (item.action === 'shorten') {
    const minutes = item.payload['estimatedMinutes'];
    return typeof minutes === 'number' ? `至 ${String(minutes)} 分钟` : '';
  }
  if (item.action === 'defer') {
    const dueDate = item.payload['dueDate'];
    return typeof dueDate === 'string' ? `至 ${dueDate}` : '';
  }
  return '';
}

/** 记录时间（服务端给 UTC ISO，这里按用户本地时区显示 `MM-DD HH:mm`）。 */
function formatRecordedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
