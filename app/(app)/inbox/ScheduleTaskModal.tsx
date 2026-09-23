'use client';

import { useState } from 'react';

import { Button, Input, Modal, Select, useAsyncQuery } from '@/shared/ui/components';

import { ApiRequestError, sendJson } from '../_lib/api-client';
import { fetchLifeAreas } from '../_lib/queries';
import modalFormStyles from '../_components/ModalForm.module.css';

export type ScheduleTaskModalProps = {
  /** 要安排的任务 id（单条「安排」与批量「安排」共用本弹窗）。 */
  readonly taskIds: readonly string[];
  readonly onClose: () => void;
  /** 安排成功后的回调；参数是本次安排的任务数。 */
  readonly onDone: (count: number) => void;
};

/**
 * 安排弹窗（UI-005）：把收件箱任务置为已安排，可选地设定截止日与生活领域。
 *
 * 走 `POST /tasks/batch`（operation=schedule）——即使只有一条：单条安排与
 * 批量安排共用同一条写路径，失败语义（整批失败、不产生部分写入）也就一致。
 */
export function ScheduleTaskModal({ taskIds, onClose, onDone }: ScheduleTaskModalProps) {
  const [dueDate, setDueDate] = useState('');
  const [lifeAreaId, setLifeAreaId] = useState('');
  const [startAtLocal, setStartAtLocal] = useState('09:00');
  const [durationMinutes, setDurationMinutes] = useState('30');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const areas = useAsyncQuery({
    queryKey: ['life-areas', 'selector'],
    queryFn: (signal) => fetchLifeAreas(signal),
  });

  const submit = async () => {
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await sendJson('POST', '/api/v1/tasks/batch', {
        taskIds,
        operation: 'schedule',
        dueDate: dueDate === '' ? null : dueDate,
        lifeAreaId: lifeAreaId === '' ? null : lifeAreaId,
      });
      // 阻塞 2 修正：安排必须同时产生时间块（否则时间线永远为空）。
      // 多选时为每个任务建一个同起点顺延的块；单选即一块。
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const blockDate = dueDate === '' ? new Date().toISOString().slice(0, 10) : dueDate;
      const duration = Math.max(1, Number(durationMinutes) || 30);
      let cursorMinutes = 0;
      for (const taskId of taskIds) {
        const startMinutes = startAtLocal.split(':');
        const baseMinutes = Number(startMinutes[0]) * 60 + Number(startMinutes[1] ?? 0);
        const toHHMM = (total: number) =>
          `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
        // 审查 8：本地墙钟必须带时区偏移，否则服务端按部署机时区解析会错点。
        const offset = new Date().getTimezoneOffset();
        const sign = offset <= 0 ? '+' : '-';
        const abs = Math.abs(offset);
        const offsetSuffix =
          sign +
          String(Math.floor(abs / 60)).padStart(2, '0') +
          ':' +
          String(abs % 60).padStart(2, '0');
        const startsAt = `${blockDate}T${toHHMM(baseMinutes + cursorMinutes)}:00${offsetSuffix}`;
        const endsAt = `${blockDate}T${toHHMM(baseMinutes + cursorMinutes + duration)}:00${offsetSuffix}`;
        await sendJson('POST', '/api/v1/schedule-blocks', {
          taskId,
          startsAt,
          endsAt,
          timezone: timeZone,
          source: 'manual',
        });
        cursorMinutes += duration;
      }
      onDone(taskIds.length);
    } catch (error) {
      setErrorMessage(error instanceof ApiRequestError ? error.message : '安排失败，请稍后重试');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title={taskIds.length === 1 ? '安排任务' : `安排 ${String(taskIds.length)} 项任务`}
      onClose={onClose}
      initialFocusSelector="[data-schedule-due-date]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button variant="primary" loading={submitting} onClick={() => void submit()}>
            安排
          </Button>
        </>
      }
    >
      <div className={modalFormStyles.fields}>
        <Input
          label="截止日期（可选）"
          type="date"
          data-schedule-due-date
          value={dueDate}
          onChange={(event) => {
            setDueDate(event.target.value);
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
        <Select
          label="生活领域（可选）"
          value={lifeAreaId}
          onChange={(event) => {
            setLifeAreaId(event.target.value);
          }}
        >
          <option value="">不指定</option>
          {areas.state.status === 'success'
            ? areas.state.data.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))
            : null}
        </Select>
        {errorMessage === null ? null : (
          <p role="alert" className={modalFormStyles.error}>
            {errorMessage}
          </p>
        )}
      </div>
    </Modal>
  );
}
