'use client';

import { useEffect, useRef, useState } from 'react';

import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Input,
  ReminderRuleInlineArea,
  Skeleton,
  useCursorListQuery,
  useToast,
} from '@/shared/ui/components';

import { ApiRequestError, sendJson } from '../_lib/api-client';
import { makeInboxQueryFn, type TaskItem } from '../_lib/queries';
import { useAiEnabled } from '../_lib/use-ai-enabled';
import { useReminderRuleStore } from '../_lib/use-reminder-rules';
import { ConvertToActionModal } from './ConvertToActionModal';
import { ScheduleTaskModal } from './ScheduleTaskModal';
import { TaskBreakdownDraftDrawer } from './TaskBreakdownDraftDrawer';
import styles from './InboxPanel.module.css';

/**
 * 收件箱（UI-005，《UI 页面规范》v0.19 §5）。
 *
 * 页面形态（§5 冻结）：首屏快速添加输入框、按最近添加排序的任务列表、
 * 「加载更多」分段加载、多选经 Checkbox 批量安排/归档、单条可转为目标行动。
 * **不提供批量删除**（§5 决策：删除走单条软删）。
 */
export function InboxPanel() {
  const { state, loadMore, refetch } = useCursorListQuery<TaskItem>({
    queryKey: ['tasks', 'inbox'],
    queryFn: makeInboxQueryFn(),
  });

  const toast = useToast();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pendingTitle, setPendingTitle] = useState('');
  const [adding, setAdding] = useState(false);
  /** 安排弹窗的目标集合：单条「安排」与批量「安排」共用一个弹窗。 */
  const [scheduleTargets, setScheduleTargets] = useState<readonly string[] | null>(null);
  /** 「转为目标行动」的目标任务。 */
  const [convertTask, setConvertTask] = useState<TaskItem | null>(null);
  /**
   * 行内提醒展开态：**同屏至多展开一行**——只存一个键，展开新行即替换旧行
   * （§5 A「展开新行先折叠旧行」，避免长列表纵向膨胀）。
   */
  const [expandedReminderKey, setExpandedReminderKey] = useState<string | null>(null);
  const reminders = useReminderRuleStore(['task']);
  // 总开关未知（加载中 / 取数失败）时不渲染入口：`ReminderRuleSection` 只接受
  // 确定的布尔值，把「还不知道」当 `false` 渲染成「总开关已关闭」是假话。
  const reminderGlobalEnabled = reminders.globalEnabled;
  const quickAddInputRef = useRef<HTMLInputElement>(null);

  // AI 关闭态（§5 E）：`null`（还没读出来）与 `false` 都不渲染「拆分任务」入口。
  const aiEnabled = useAiEnabled();
  /** 「拆分任务」草稿面板的原文；`null` 表示面板未打开。 */
  const [breakdownText, setBreakdownText] = useState<string | null>(null);

  const startBreakdown = () => {
    const text = pendingTitle.trim();
    if (text === '') {
      return;
    }
    setBreakdownText(text);
  };

  // 顶栏「＋快速添加」跳转 `/inbox#quick-add`（UI v0.19 §5）：落页后聚焦输入框。
  useEffect(() => {
    if (window.location.hash === '#quick-add') {
      quickAddInputRef.current?.focus();
    }
  }, []);

  /** 翻转某行的提醒展开态（同屏至多一行：展开新行即折叠旧行）。 */
  const toggleReminderRow = (rowKey: string) => {
    setExpandedReminderKey((current) => (current === rowKey ? null : rowKey));
  };

  const toggleSelected = (taskId: string, nextChecked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (nextChecked) {
        next.add(taskId);
      } else {
        next.delete(taskId);
      }
      return next;
    });
  };

  const addToInbox = async () => {
    const title = pendingTitle.trim();
    if (title === '') {
      return;
    }
    setAdding(true);
    try {
      await sendJson('POST', '/api/v1/tasks', { title });
      setPendingTitle('');
      toast.success('已加入收件箱');
      refetch();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '添加失败，请稍后重试');
    } finally {
      setAdding(false);
    }
  };

  const archiveTasks = async (taskIds: readonly string[]) => {
    try {
      if (taskIds.length === 1) {
        await sendJson('POST', `/api/v1/tasks/${taskIds[0]}/archive`);
      } else {
        await sendJson('POST', '/api/v1/tasks/batch', { taskIds, operation: 'archive' });
      }
      toast.success(taskIds.length === 1 ? '已归档' : `已归档 ${String(taskIds.length)} 项`);
      setSelected(new Set());
      refetch();
    } catch (error) {
      // 整批失败时保留选择（§4.8）：用户可以直接重试或先调整选择。
      toast.error(error instanceof ApiRequestError ? error.message : '归档失败，请稍后重试');
    }
  };

  // 入口只在 AI 开着时出现（§5 E）：`undefined` 表示不渲染那个次按钮。
  const breakdownEntry = aiEnabled === true ? startBreakdown : undefined;
  const breakdownDrawer =
    breakdownText === null ? null : (
      <TaskBreakdownDraftDrawer
        text={breakdownText}
        onClose={() => {
          setBreakdownText(null);
        }}
        onConfirmed={refetch}
      />
    );

  if (state.status === 'loading') {
    return (
      <section className={styles.section}>
        <QuickAddForm
          inputRef={quickAddInputRef}
          title={pendingTitle}
          onChange={setPendingTitle}
          onSubmit={addToInbox}
          adding={adding}
          onBreakdown={breakdownEntry}
        />
        {breakdownDrawer}
        <div className={styles.skeleton}>
          <Skeleton />
          <Skeleton width="90%" />
          <Skeleton width="95%" />
        </div>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className={styles.section}>
        <QuickAddForm
          inputRef={quickAddInputRef}
          title={pendingTitle}
          onChange={setPendingTitle}
          onSubmit={addToInbox}
          adding={adding}
          onBreakdown={breakdownEntry}
        />
        {breakdownDrawer}
        <ErrorState
          title="收件箱没能加载"
          description="数据没能取回来。可以先重试。"
          action={
            <Button variant="primary" onClick={refetch}>
              重试
            </Button>
          }
        />
      </section>
    );
  }

  if (state.items.length === 0) {
    return (
      <section className={styles.section}>
        <QuickAddForm
          inputRef={quickAddInputRef}
          title={pendingTitle}
          onChange={setPendingTitle}
          onSubmit={addToInbox}
          adding={adding}
          onBreakdown={breakdownEntry}
        />
        {breakdownDrawer}
        {/* 空态也算「列表容器」（§ B 表：`inbox-list` 含空态），故与有数据时同一锚点。 */}
        <div data-tour="inbox-list">
          <EmptyState
            title="收件箱是空的"
            description="在上面的输入框记下第一条任务，之后再安排到具体的时间。"
          />
        </div>
      </section>
    );
  }

  return (
    <section className={styles.section}>
      <QuickAddForm
        inputRef={quickAddInputRef}
        title={pendingTitle}
        onChange={setPendingTitle}
        onSubmit={addToInbox}
        adding={adding}
        onBreakdown={breakdownEntry}
      />
      {breakdownDrawer}

      {selected.size > 0 ? (
        <div className={styles.toolbar} role="toolbar" aria-label="批量操作">
          <span className={styles.selectedCount}>已选 {String(selected.size)} 项</span>
          <Button
            variant="secondary"
            onClick={() => {
              setScheduleTargets([...selected]);
            }}
          >
            批量安排
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              void archiveTasks([...selected]);
            }}
          >
            批量归档
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setSelected(new Set());
            }}
          >
            取消选择
          </Button>
        </div>
      ) : null}

      <ul className={styles.list} data-tour="inbox-list">
        {state.items.map((task) => (
          <li key={task.id} className={styles.row}>
            <Checkbox
              label={`选择任务：${task.title}`}
              checked={selected.has(task.id)}
              onChange={(nextChecked) => {
                toggleSelected(task.id, nextChecked);
              }}
            />
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}>{task.title}</span>
              {task.dueDate === null ? null : (
                <span className={styles.rowMeta}>截至 {task.dueDate}</span>
              )}
            </div>
            <div className={styles.rowActions}>
              <Button
                variant="ghost"
                onClick={() => {
                  setScheduleTargets([task.id]);
                }}
              >
                安排
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setConvertTask(task);
                }}
              >
                转行动
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void archiveTasks([task.id]);
                }}
              >
                归档
              </Button>
            </div>
            {/* 铃铛排在行尾既有动作之后（§5 A「共存与可达」），不与它们重排。 */}
            {reminderGlobalEnabled === null ? null : (
              <ReminderRuleInlineArea
                label="为该任务添加提醒"
                controlsId={`reminder-task-${task.id}`}
                expanded={expandedReminderKey === `task:${task.id}`}
                onToggleExpanded={() => {
                  toggleReminderRow(`task:${task.id}`);
                }}
                section={{
                  state: reminders.stateFor('task', task.id),
                  onRetry: reminders.retry,
                  globalEnabled: reminderGlobalEnabled,
                  permission: reminders.permission,
                  onRequestPermission: reminders.requestPermission,
                  onCreate: (draft) => reminders.createRule('task', task.id, draft),
                  onToggle: reminders.toggleRule,
                }}
              />
            )}
          </li>
        ))}
      </ul>

      {state.loadMoreError !== null ? (
        <p className={styles.loadMoreError} role="alert">
          上一页没能加载完。
          <Button variant="ghost" onClick={loadMore}>
            重试
          </Button>
        </p>
      ) : state.hasMore ? (
        <div className={styles.loadMoreRow}>
          <Button variant="secondary" loading={state.isLoadingMore} onClick={loadMore}>
            加载更多
          </Button>
        </div>
      ) : null}

      {scheduleTargets === null ? null : (
        <ScheduleTaskModal
          taskIds={scheduleTargets}
          onClose={() => {
            setScheduleTargets(null);
          }}
          onDone={(count) => {
            setScheduleTargets(null);
            setSelected(new Set());
            toast.success(count === 1 ? '已安排' : `已安排 ${String(count)} 项`);
            refetch();
          }}
        />
      )}

      {convertTask === null ? null : (
        <ConvertToActionModal
          task={convertTask}
          onClose={() => {
            setConvertTask(null);
          }}
          onDone={() => {
            setConvertTask(null);
            toast.success('已转为目标行动，任务移入已安排');
            refetch();
          }}
        />
      )}
    </section>
  );
}

type QuickAddFormProps = {
  readonly inputRef: React.Ref<HTMLInputElement>;
  readonly title: string;
  readonly onChange: (next: string) => void;
  readonly onSubmit: () => void;
  readonly adding: boolean;
  /**
   * 「拆分任务」次按钮（§5 C1）。给出时才渲染——AI 关闭或还没读出来（§5 E）时
   * 调用方传 `undefined`，入口不出现、也不留禁用态。
   */
  readonly onBreakdown?: (() => void) | undefined;
};

/**
 * 首屏快速添加（§5：输入框在首屏，提交即进收件箱）。
 *
 * 「拆分任务」是输入框旁的**次按钮**（§5 C1 明文），它取当前输入框里的原文去生成
 * 草稿；原文为空时不可点（没有可拆解的东西）。
 */
function QuickAddForm({
  inputRef,
  title,
  onChange,
  onSubmit,
  adding,
  onBreakdown,
}: QuickAddFormProps) {
  return (
    <form
      id="quick-add"
      className={styles.quickAdd}
      data-tour="inbox-quick-add"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Input
        ref={inputRef}
        label="快速添加任务"
        placeholder="想到什么就记下来，例如：整理书桌"
        value={title}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <Button type="submit" variant="primary" loading={adding}>
        添加
      </Button>
      {onBreakdown === undefined ? null : (
        <Button variant="secondary" disabled={title.trim() === '' || adding} onClick={onBreakdown}>
          拆分任务
        </Button>
      )}
    </form>
  );
}
