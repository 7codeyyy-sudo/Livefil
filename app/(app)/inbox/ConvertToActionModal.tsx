'use client';

import { useState } from 'react';

import { Button, Input, Modal, Select } from '@/shared/ui/components';

import { ApiRequestError, sendJson } from '../_lib/api-client';
import { makeGoalsQueryFn, type TaskItem } from '../_lib/queries';
import modalFormStyles from '../_components/ModalForm.module.css';
import { useAsyncQuery } from '@/shared/ui/components';

export type ConvertToActionModalProps = {
  readonly task: TaskItem;
  readonly onClose: () => void;
  /** 转换成功后的回调（任务保留、进入已安排，列表需刷新）。 */
  readonly onDone: () => void;
};

/**
 * 「转为目标行动」弹窗（UI-005，GOAL-002）。
 *
 * 在选定目标下创建行动并回填任务关联；任务保留、状态进入已安排（§5 决策：
 * 转行动**不是**把任务变成目标的一部分并丢弃——它只是"这件事换个层级推进"）。
 */
export function ConvertToActionModal({ task, onClose, onDone }: ConvertToActionModalProps) {
  const [goalId, setGoalId] = useState('');
  const [name, setName] = useState(task.title);
  const [minimumVersion, setMinimumVersion] = useState(task.minimumVersion ?? '');
  const [estimatedMinutes, setEstimatedMinutes] = useState(
    task.estimatedMinutes === null ? '' : String(task.estimatedMinutes),
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const goals = useAsyncQuery({
    queryKey: ['goals', 'selector'],
    queryFn: (signal) => makeGoalsQueryFn('active')(signal, null),
  });

  const submit = async () => {
    if (goalId === '') {
      setErrorMessage('请选择一个目标');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await sendJson('POST', `/api/v1/tasks/${task.id}/convert-to-action`, {
        goalId,
        ...(name.trim() === task.title ? {} : { name: name.trim() }),
        ...(minimumVersion.trim() === '' ? {} : { minimumVersion: minimumVersion.trim() }),
        ...(estimatedMinutes.trim() === '' ? {} : { estimatedMinutes: Number(estimatedMinutes) }),
      });
      onDone();
    } catch (error) {
      setErrorMessage(error instanceof ApiRequestError ? error.message : '转换失败，请稍后重试');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title="转为目标行动"
      onClose={onClose}
      initialFocusSelector="[data-convert-goal]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button variant="primary" loading={submitting} onClick={() => void submit()}>
            转为行动
          </Button>
        </>
      }
    >
      <div className={modalFormStyles.fields}>
        <Select
          label="目标"
          data-convert-goal
          value={goalId}
          onChange={(event) => {
            setGoalId(event.target.value);
          }}
        >
          <option value="">选择一个目标…</option>
          {goals.state.status === 'success'
            ? goals.state.data.items.map((goal) => (
                <option key={goal.id} value={goal.id}>
                  {goal.name}
                </option>
              ))
            : null}
        </Select>
        <Input
          label="行动名称"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <Input
          label="最低版本（可选）"
          hint="状态很差时至少能完成的量，例如：散步 8 分钟"
          value={minimumVersion}
          onChange={(event) => {
            setMinimumVersion(event.target.value);
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
        {errorMessage === null ? null : (
          <p role="alert" className={modalFormStyles.error}>
            {errorMessage}
          </p>
        )}
      </div>
    </Modal>
  );
}
