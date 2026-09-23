'use client';

import { useState } from 'react';

import { Button, Input, Modal, useToast } from '@/shared/ui/components';

import { ApiRequestError, sendJson } from '../_lib/api-client';
import modalFormStyles from './ModalForm.module.css';

export interface EditableBlock {
  readonly id: string;
  readonly taskId: string | null;
  readonly title: string | null;
  readonly startsAtUtc: string;
  readonly endsAtUtc: string;
  readonly status: string;
  readonly version: number;
}

/** `HH:mm` 本地钟点。 */
function clockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** 本地墙钟 + 时区偏移的 ISO（审查 8：`2026-09-23T09:00:00` 无偏移会被服务端按自身时区解析）。 */
function localOffsetIso(date: string, time: string): string {
  const naive = new Date(`${date}T${time}:00`);
  const offsetMinutes = -naive.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${date}T${time}:00${sign}${hh}:${mm}`;
}

export type EditBlockModalProps = {
  readonly block: EditableBlock;
  readonly onClose: () => void;
  readonly onSaved: () => void;
};

/**
 * 块编辑弹层（SCHED-003「点击编辑作为移动端替代」/ 周视图「点击块编辑」，
 * 审查阻塞 1/3）。PATCH `/schedule-blocks/{id}`（乐观并发 + 冲突重检回传）。
 */
export function EditBlockModal({ block, onClose, onSaved }: EditBlockModalProps) {
  const toast = useToast();
  const [startAtLocal, setStartAtLocal] = useState(clockOf(block.startsAtUtc));
  const [duration, setDuration] = useState(
    String(
      Math.max(
        1,
        Math.round((Date.parse(block.endsAtUtc) - Date.parse(block.startsAtUtc)) / 60_000),
      ),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const todayIso = block.startsAtUtc.slice(0, 10);

  const save = async () => {
    setSaving(true);
    setErrorMessage(null);
    const durationMinutes = Math.max(1, Number(duration) || 30);
    try {
      await sendJson(
        'PATCH',
        `/api/v1/schedule-blocks/${block.id}`,
        {
          version: block.version,
          startsAt: localOffsetIso(todayIso, startAtLocal),
          endsAt: localOffsetIso(
            todayIso,
            // 跨零点：分钟和可能超过 24h——服务端按 ISO 解析，日期取当天即可（时长 ≤ 24h 由输入限制）。
            (() => {
              const parts = startAtLocal.split(':');
              const total = Number(parts[0]) * 60 + Number(parts[1] ?? 0) + durationMinutes;
              return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
            })(),
          ),
          confirmConflicts: true,
        },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
      );
      toast.success('时间块已调整');
      onSaved();
    } catch (error) {
      setErrorMessage(error instanceof ApiRequestError ? error.message : '调整失败，请稍后重试');
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={`调整「${block.title ?? '自由安排'}」`}
      onClose={onClose}
      initialFocusSelector="[data-edit-start]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
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
          label="开始时间"
          type="time"
          data-edit-start
          value={startAtLocal}
          onChange={(event) => {
            setStartAtLocal(event.target.value);
          }}
        />
        <Input
          label="时长（分钟）"
          type="number"
          min={1}
          value={duration}
          onChange={(event) => {
            setDuration(event.target.value);
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
