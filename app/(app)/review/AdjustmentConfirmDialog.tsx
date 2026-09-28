'use client';

import { useState } from 'react';

import { Button, ConfirmDialog, Input } from '@/shared/ui/components';

import { ADJUSTMENT_LABELS } from '../_lib/review-api';
import type { AdjustmentAction, AdjustmentTargetType } from '../_lib/review-api';

import styles from './ReviewPanel.module.css';

/**
 * 待确认的一次调整（B4：每个动作提交前必经 ConfirmDialog，不静默执行）。
 */
export interface PendingAdjustment {
  readonly action: AdjustmentAction;
  readonly targetType: AdjustmentTargetType;
  readonly targetId: string;
  readonly targetName: string;
  /** 缩短动作的默认值（该任务当前预计时长）；契约里取不到时为 `null`。 */
  readonly currentEstimatedMinutes: number | null;
  /**
   * 延期动作的落位日期。
   *
   * 由调用方按周口径算好（有原定日期则顺推一周，否则落下周首日）：这里只负责
   * 显示与提交，不在弹窗里再算一遍日期——两个地方各算一次的典型后果是
   * 「正文说的」与「提交的」不是同一天。
   */
  readonly deferDueDate: string;
}

export type AdjustmentPayloadInput = Readonly<Record<string, unknown>>;

export type AdjustmentConfirmDialogProps = {
  readonly pending: PendingAdjustment;
  readonly submitting: boolean;
  /** 上一次提交的失败信息（`null` 表示还没失败过）。 */
  readonly errorMessage: string | null;
  readonly offline: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (payload: AdjustmentPayloadInput) => void;
};

/**
 * 调整确认弹窗（B4）。
 *
 * ## 为什么复用 ConfirmDialog 而不是自造浮层
 *
 * B4 明文「每个动作提交前必经 ConfirmDialog」（§4.5 冻结件）。这里只做三件
 * 与动作有关的事：正文按动作取一句冻结文案、`shorten` 多一个数值输入、失败时
 * 就地插错误行——浮层机制（焦点陷阱、ESC、遮罩、退场）一概不重写。
 *
 * ## 为什么状态不需要在 pending 变化时重置
 *
 * 调用方**只在有待确认动作时挂载**本组件、并以「动作 + 目标」为 `key`。于是
 * 「换一个动作」＝换一个组件实例，`useState` 的初值天然重来一次，不必写
 * effect 回填（React 19 也禁止在 effect 里同步 setState 做这件事）。
 *
 * ## 数值输入的落点
 *
 * §4.5 只允许「一个数值输入」，所以它进 `descriptionSlot`（正文的一部分），
 * 而不是另开一个表单区。错误行进 `errorSlot`：不关弹窗、不清已填参数，
 * 用户按「重试」或修正后按确认按钮都能重发（§4.9.2 同型处理）。
 */
export function AdjustmentConfirmDialog({
  pending,
  submitting,
  errorMessage,
  offline,
  onCancel,
  onConfirm,
}: AdjustmentConfirmDialogProps) {
  const [minutes, setMinutes] = useState(
    pending.currentEstimatedMinutes === null ? '' : String(pending.currentEstimatedMinutes),
  );
  const [minutesError, setMinutesError] = useState<string | null>(null);

  const handleConfirm = () => {
    if (pending.action === 'shorten') {
      const value = minutes.trim();
      // 只接受正整数分钟（契约 §10：`estimatedMinutes` 为正整数，422 会挡下非整数）。
      if (!/^\d+$/.test(value) || Number(value) <= 0) {
        setMinutesError('请填写大于 0 的整数分钟数');
        return;
      }
      setMinutesError(null);
      onConfirm({ estimatedMinutes: Number(value) });
      return;
    }

    if (pending.action === 'defer') {
      onConfirm({ dueDate: pending.deferDueDate });
      return;
    }

    // 保留 / 暂停目标 / 删除：payload 为空对象（接口 §10 的五动作表）。
    onConfirm({});
  };

  const description = describe(pending, offline);

  return (
    <ConfirmDialog
      open
      title={ADJUSTMENT_LABELS[pending.action]}
      description={description}
      confirmLabel={ADJUSTMENT_LABELS[pending.action]}
      pending={submitting}
      // 删除是破坏性动作：确认按钮走 danger，且初始焦点落「取消」（§4.5 安全默认）。
      destructive={pending.action === 'delete'}
      onCancel={onCancel}
      onConfirm={handleConfirm}
      descriptionSlot={
        pending.action === 'shorten' ? (
          <Input
            label="缩短为（分钟）"
            type="number"
            min={1}
            inputMode="numeric"
            value={minutes}
            error={minutesError ?? undefined}
            onChange={(event) => {
              setMinutes(event.target.value);
            }}
          />
        ) : undefined
      }
      errorSlot={
        errorMessage === null ? undefined : (
          <>
            <p className={styles.error} role="alert">
              {errorMessage}
            </p>
            <Button variant="ghost" onClick={handleConfirm} disabled={submitting}>
              重试
            </Button>
          </>
        )
      }
    />
  );
}

/**
 * 正文：目标名 + 一句话后果（B4 冻结文案逐条对应）。
 *
 * `shorten` 的数值输入在 `descriptionSlot`（正文之上），所以这一句说的是
 * 「缩短为上面填写的分钟数」而不是把输入框塞进句子中间。
 */
function describe(pending: PendingAdjustment, offline: boolean): string {
  const name = pending.targetName;
  const offlineNote = offline ? ' 当前处于离线状态，提交会失败——请恢复网络后再试。' : '';

  switch (pending.action) {
    case 'keep':
      return `保留《${name}》，不改动下周计划。${offlineNote}`;
    case 'shorten':
      return `将《${name}》预计时长缩短为上面填写的分钟数${currentMinutesNote(pending)}。${offlineNote}`;
    case 'defer':
      return `把《${name}》移到下周计划（${pending.deferDueDate}）。${offlineNote}`;
    case 'pause':
      return `暂停目标《${name}》，暂停期间不再推进，可后续恢复。${offlineNote}`;
    case 'delete':
      return `删除任务《${name}》。${offlineNote}`;
  }
}

/** 缩短动作的默认值说明（B4：默认当前预计时长）。 */
function currentMinutesNote(pending: PendingAdjustment): string {
  return pending.currentEstimatedMinutes === null
    ? '（该任务未设置预计时长，请填写）'
    : `（默认当前预计时长 ${String(pending.currentEstimatedMinutes)} 分钟）`;
}
