'use client';

import { useState } from 'react';

import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  Skeleton,
  useCursorListQuery,
  useToast,
} from '@/shared/ui/components';

import { ApiRequestError, sendJson } from '../_lib/api-client';
import { makeGoalsQueryFn, type GoalItem } from '../_lib/queries';
import styles from './GoalsPanel.module.css';

/**
 * 目标页（UI-006，《UI 页面规范》v0.18 §5）。
 *
 * 列表给出名称与**双进度**的摘要（结果进度随手改、行动进度由行动汇总）；
 * 每行进详情（`/goals/[goalId]`，独立路由——可直链、可刷新）。
 * 新建目标走页内的最小表单（名称必填，其余在详情里补）。
 */
export function GoalsPanel() {
  const { state, refetch } = useCursorListQuery<GoalItem>({
    queryKey: ['goals'],
    queryFn: makeGoalsQueryFn(),
  });

  return (
    <section className={styles.section}>
      <CreateGoalForm onCreated={refetch} />
      <GoalList state={state} onRetry={refetch} />
    </section>
  );
}

type GoalListState = ReturnType<typeof useCursorListQuery<GoalItem>>['state'];

function GoalList({
  state,
  onRetry,
}: {
  readonly state: GoalListState;
  readonly onRetry: () => void;
}) {
  if (state.status === 'loading') {
    return (
      <div className={styles.skeleton}>
        <Skeleton />
        <Skeleton width="85%" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <ErrorState
        title="目标没能加载"
        description="数据没能取回来。可以先重试。"
        action={
          <Button variant="primary" onClick={onRetry}>
            重试
          </Button>
        }
      />
    );
  }
  if (state.items.length === 0) {
    return (
      <EmptyState
        title="还没有目标"
        description="在上面写下你想改变的一件事，给它一个可衡量的结果。"
      />
    );
  }
  return (
    <ul className={styles.list}>
      {state.items.map((goal) => (
        <li key={goal.id} className={styles.row}>
          <a className={styles.rowLink} href={`/goals/${goal.id}`}>
            <span className={styles.rowName}>{goal.name}</span>
            <GoalProgressSummary goal={goal} />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** 结果进度的摘要（有 target 时给比值，没有就只给当前值；不自动判完成）。 */
function GoalProgressSummary({ goal }: { readonly goal: GoalItem }) {
  const metric = goal.resultMetric;
  if (metric === null || (metric.current === null && metric.target === null)) {
    return <span className={styles.rowMeta}>还没有记录结果进度</span>;
  }
  const current = metric.current === null ? '—' : String(metric.current);
  const target = metric.target === null ? null : String(metric.target);
  return (
    <span className={styles.rowMeta}>
      结果进度：{current}
      {target === null ? '' : ` / ${target}`}
      {metric.unit === null ? '' : ` ${metric.unit}`}
    </span>
  );
}

function CreateGoalForm({ onCreated }: { readonly onCreated: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [creating, setCreating] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      return;
    }
    setCreating(true);
    try {
      await sendJson('POST', '/api/v1/goals', {
        name: trimmed,
        ...(targetDate === '' ? {} : { targetDate }),
      });
      setName('');
      setTargetDate('');
      toast.success('目标已创建');
      onCreated();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '创建失败，请稍后重试');
    } finally {
      setCreating(false);
    }
  };

  return (
    <form
      className={styles.createForm}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        label="新建目标"
        placeholder="例如：三个月内能跑 5 公里"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <Input
        label="目标日期（可选）"
        type="date"
        value={targetDate}
        onChange={(event) => {
          setTargetDate(event.target.value);
        }}
      />
      <Button type="submit" variant="primary" loading={creating}>
        创建目标
      </Button>
    </form>
  );
}
