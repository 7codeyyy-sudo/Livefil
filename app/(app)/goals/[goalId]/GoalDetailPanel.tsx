'use client';

import { useState } from 'react';

import {
  Button,
  ConfirmDialog,
  ErrorState,
  Input,
  Modal,
  Skeleton,
  useAsyncQuery,
  useToast,
} from '@/shared/ui/components';

import { ApiRequestError, fetchJson, sendJson } from '../../_lib/api-client';
import modalFormStyles from '../../_components/ModalForm.module.css';
import { localCalendarDate, type GoalDetailData } from '../../_lib/queries';
import styles from './GoalDetailPanel.module.css';

/**
 * 目标详情面板（UI-006，《UI 页面规范》v0.18 §5）。
 *
 * **双进度分开**（§5 冻结）：「结果进度」是用户手动维护的 resultMetric
 * （就地编辑，服务端不据它判完成）；「行动进度」由行动状态汇总，只读。
 * 详情可直接新增行动；行动的完成/停做就地切换；删除行动走确认弹窗
 * （软删 + 解链任务，任务不删）。
 */
export function GoalDetailPanel({ goalId }: { readonly goalId: string }) {
  const detail = useAsyncQuery({
    queryKey: ['goals', 'detail', goalId],
    queryFn: (signal) =>
      fetchJson<GoalDetailData>(`/api/v1/goals/${goalId}`, signal).then(
        (envelope) => envelope.data,
      ),
  });
  const toast = useToast();

  if (detail.state.status === 'loading') {
    return (
      <div className={styles.section}>
        <Skeleton />
        <Skeleton width="70%" />
        <Skeleton width="85%" />
      </div>
    );
  }
  if (detail.state.status === 'error') {
    return (
      <ErrorState
        title="目标详情没能加载"
        description="数据没能取回来。可以先重试。"
        action={
          <Button variant="primary" onClick={detail.refetch}>
            重试
          </Button>
        }
      />
    );
  }

  const data = detail.state.data;

  const mutate = async (action: () => Promise<unknown>, successMessage: string) => {
    try {
      await action();
      toast.success(successMessage);
      detail.refetch();
      return true;
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '操作失败，请稍后重试');
      return false;
    }
  };

  return (
    <div className={styles.section}>
      <section className={styles.block}>
        <h2 className={styles.blockTitle}>{data.goal.name}</h2>
        <ResultMetricEditor
          goalId={goalId}
          version={data.goal.version}
          resultMetric={data.goal.resultMetric}
          onSaved={detail.refetch}
        />
        <p className={styles.hint}>结果进度由你手动维护；服务端不会根据数值自动判定目标完成。</p>
      </section>

      <section className={styles.block}>
        <h2 className={styles.blockTitle}>行动进度</h2>
        <p className={styles.progressLine}>
          共 {String(data.actionProgress.total)} 项 · 完成 {String(data.actionProgress.completed)} ·
          进行中 {String(data.actionProgress.active)} · 停做 {String(data.actionProgress.paused)}
        </p>
      </section>

      <section className={styles.block}>
        <h2 className={styles.blockTitle}>行动</h2>
        {data.actions.length === 0 ? (
          <p className={styles.hint}>还没有行动。用下面的表单把目标拆成第一步。</p>
        ) : (
          <ul className={styles.actionList}>
            {data.actions.map((action) => (
              <li key={action.id} className={styles.actionRow}>
                <span className={styles.actionName}>{action.name}</span>
                <ActionControls
                  actionId={action.id}
                  version={action.version}
                  status={action.status}
                  onChanged={(run, message) => {
                    void mutate(run, message);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        <AddActionForm goalId={goalId} onAdded={detail.refetch} />
      </section>

      <section className={styles.block}>
        <h2 className={styles.blockTitle}>今日任务</h2>
        <AddTodayTaskForm goalId={goalId} onAdded={detail.refetch} />
      </section>
    </div>
  );
}

type ResultMetric = NonNullable<GoalDetailData['goal']['resultMetric']>;

/** 结果进度的就地编辑（§5：手动 resultMetric 与行动进度分开、标签明确）。 */
function ResultMetricEditor({
  goalId,
  version,
  resultMetric,
  onSaved,
}: {
  readonly goalId: string;
  readonly version: number;
  readonly resultMetric: ResultMetric | null;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState(
    resultMetric?.current === null || resultMetric?.current === undefined
      ? ''
      : String(resultMetric.current),
  );
  const [target, setTarget] = useState(
    resultMetric?.target === null || resultMetric?.target === undefined
      ? ''
      : String(resultMetric.target),
  );
  const [unit, setUnit] = useState(resultMetric?.unit ?? '');
  const [note, setNote] = useState(resultMetric?.note ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await sendJson('PATCH', `/api/v1/goals/${goalId}`, {
        version,
        resultMetric: {
          current: current.trim() === '' ? null : Number(current),
          target: target.trim() === '' ? null : Number(target),
          unit: unit.trim() === '' ? null : unit.trim(),
          note: note.trim() === '' ? null : note.trim(),
        },
      });
      setEditing(false);
      onSaved();
    } catch (error) {
      // 409（版本冲突）在这里最常见：提示刷新而不是让用户反复重试。
      toast.error(error instanceof ApiRequestError ? error.message : '保存失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    const metric = resultMetric;
    const summary =
      metric === null || (metric.current === null && metric.target === null)
        ? '还没有记录结果进度'
        : `当前 ${metric.current ?? '—'}${metric.target === null ? '' : ` / 目标 ${String(metric.target)}`}${metric.unit === null ? '' : `（${metric.unit}）`}`;
    return (
      <div className={styles.metricRow}>
        <span className={styles.metricSummary}>{summary}</span>
        <Button
          variant="secondary"
          onClick={() => {
            setEditing(true);
          }}
        >
          更新结果进度
        </Button>
      </div>
    );
  }

  return (
    <Modal
      open
      title="更新结果进度"
      onClose={() => {
        setEditing(false);
      }}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              setEditing(false);
            }}
            disabled={saving}
          >
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      <div className={modalFormStyles.fields}>
        <Input
          label="当前值"
          type="number"
          value={current}
          onChange={(event) => {
            setCurrent(event.target.value);
          }}
        />
        <Input
          label="目标值（可选）"
          type="number"
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
          }}
        />
        <Input
          label="单位（可选）"
          hint="例如：公里、页、次"
          value={unit}
          onChange={(event) => {
            setUnit(event.target.value);
          }}
        />
        <Input
          label="备注（可选）"
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </div>
    </Modal>
  );
}

type ActionControlsProps = {
  readonly actionId: string;
  readonly version: number;
  readonly status: string;
  /** `run` 是已经组装好的写请求；`message` 是成功后的提示。 */
  readonly onChanged: (run: () => Promise<unknown>, message: string) => void;
};

/** 单个行动的就地控制：完成 / 停做（或恢复）与删除（确认弹窗）。 */
function ActionControls({ actionId, version, status, onChanged }: ActionControlsProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const toggleStatus = () => {
    const nextStatus = status === 'completed' ? 'active' : 'completed';
    onChanged(
      () => sendJson('PATCH', `/api/v1/actions/${actionId}`, { version, status: nextStatus }),
      nextStatus === 'completed' ? '行动已完成' : '行动已恢复',
    );
  };

  const remove = () => {
    onChanged(
      () => sendJson('DELETE', `/api/v1/actions/${actionId}`),
      '行动已删除；关联任务已解链、任务本身保留',
    );
  };

  return (
    <div className={styles.actionControls}>
      <Button variant="ghost" onClick={toggleStatus}>
        {status === 'completed' ? '恢复' : '完成'}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setConfirmingDelete(true);
        }}
      >
        删除
      </Button>
      {confirmingDelete ? (
        <ConfirmDialog
          open
          destructive
          title="删除这个行动？"
          description="行动会被软删；关联到它的任务会解除关联，但任务本身不会被删除。"
          confirmLabel="删除"
          onCancel={() => {
            setConfirmingDelete(false);
          }}
          onConfirm={() => {
            setConfirmingDelete(false);
            remove();
          }}
        />
      ) : null}
    </div>
  );
}

/** 新增行动（§5：详情可直接新增行动）。 */
function AddActionForm({
  goalId,
  onAdded,
}: {
  readonly goalId: string;
  readonly onAdded: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [estimatedMinutes, setEstimatedMinutes] = useState('');
  const [minimumVersion, setMinimumVersion] = useState('');
  const [adding, setAdding] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      return;
    }
    setAdding(true);
    try {
      await sendJson('POST', `/api/v1/goals/${goalId}/actions`, {
        name: trimmed,
        ...(estimatedMinutes.trim() === '' ? {} : { estimatedMinutes: Number(estimatedMinutes) }),
        ...(minimumVersion.trim() === '' ? {} : { minimumVersion: minimumVersion.trim() }),
      });
      setName('');
      setEstimatedMinutes('');
      setMinimumVersion('');
      toast.success('行动已添加');
      onAdded();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '添加失败，请稍后重试');
    } finally {
      setAdding(false);
    }
  };

  return (
    <form
      className={styles.addAction}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        label="新增行动"
        placeholder="把目标拆成能落地的一步"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <Input
        label="预计时长（分钟，可选）"
        type="number"
        min={1}
        value={estimatedMinutes}
        onChange={(event) => {
          setEstimatedMinutes(event.target.value);
        }}
      />
      <Input
        label="最低版本（可选）"
        hint="状态很差时至少能完成的量"
        value={minimumVersion}
        onChange={(event) => {
          setMinimumVersion(event.target.value);
        }}
      />
      <Button type="submit" variant="primary" loading={adding}>
        添加行动
      </Button>
    </form>
  );
}

/**
 * 新增「今日任务」（任务清单 L514 裁决：详情页可直接为今日排一条任务）。
 *
 * 单次 `POST /tasks` 直达 `planned`：`createTaskSchema` 本就允许创建时定状态，
 * 无需先落收件箱再流转。`dueDate` **必给**——今日页按 `from/to=今天` 过滤，
 * 不给日期的任务不会出现在今日视图（这正是裁决让 L466 让位于 L514 的原因）。
 */
function AddTodayTaskForm({
  goalId,
  onAdded,
}: {
  readonly goalId: string;
  readonly onAdded: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed === '') {
      return;
    }
    setAdding(true);
    try {
      await sendJson('POST', '/api/v1/tasks', {
        title: trimmed,
        goalId,
        status: 'planned',
        dueDate: localCalendarDate(),
      });
      setTitle('');
      toast.success('已加入今日任务');
      onAdded();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '添加失败，请稍后重试');
    } finally {
      setAdding(false);
    }
  };

  return (
    <form
      className={styles.addAction}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        label="新增今日任务"
        placeholder="今天想为这个目标推进的一小步"
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />
      <Button type="submit" variant="primary" loading={adding}>
        添加今日任务
      </Button>
    </form>
  );
}
