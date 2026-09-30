'use client';

import Link from 'next/link';
import { useState } from 'react';

import { AsyncState } from '../AsyncState/AsyncState';
import type { AsyncQueryState } from '../AsyncState/use-async-query';
import { Badge } from '../Badge/Badge';
import { Button } from '../Button/Button';
import { Checkbox } from '../Checkbox/Checkbox';
import { Input } from '../Input/Input';
import { Skeleton } from '../LoadingState/Skeleton';
import { NotificationPermissionNotice } from '../NotificationPermissionNotice/NotificationPermissionNotice';
import type { NotificationPermissionStatus } from '../NotificationPermissionNotice/NotificationPermissionNotice';
import { Select } from '../Select/Select';
import { Switch } from '../Switch/Switch';
import { useToast } from '../Toast/toast-context';

import styles from './ReminderRuleSection.module.css';

/** 重复规则三值（与接口文档 §16 `repeatRule` 同域）。 */
export type ReminderRepeatRule = 'none' | 'daily' | 'weekly';

const REPEAT_OPTIONS: readonly { readonly value: ReminderRepeatRule; readonly label: string }[] = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
];

const REPEAT_LABELS: Readonly<Record<ReminderRepeatRule, string>> = {
  none: '不重复',
  daily: '每天',
  weekly: '每周',
};

/** 「允许在安静时段提醒」的冻结文案（§5 A）。可见文字与无障碍名称共用一份。 */
const QUIET_HOURS_LABEL = '允许在安静时段提醒';

/** 触达边界说明的冻结文案（§5 D，两处宿主同文案）。 */
const REACH_NOTICE =
  '需保持页面打开才可收到提醒；关闭页面期间的提醒，将在下次打开应用时于应用内面板显示。';

/**
 * 触达边界说明行（《UI 页面规范》v0.23 §5 D）。
 *
 * 抽成组件是因为它有**两个宿主**（设置页分区 4 与对象提醒区），而 D 节要求
 * 「同文案」——两处各抄一遍必然在某次措辞调整后漂移。
 */
export function ReminderReachNotice() {
  return (
    <p className={styles.reachNotice} data-variant="reminder-reach-notice">
      {REACH_NOTICE}
    </p>
  );
}

/** 规则列表一行（由调用方从 §16 载荷映射）。 */
export interface ReminderRuleRow {
  readonly ruleId: string;
  /** 提醒时刻，`HH:MM:SS`（服务端形态，展示时截到分钟）。 */
  readonly remindAt: string;
  readonly repeatRule: ReminderRepeatRule;
  readonly allowQuietHours: boolean;
  readonly enabled: boolean;
}

/** 创建行的提交载荷。`remindAt` 已归一为服务端要求的 `HH:MM:SS`。 */
export interface ReminderRuleDraft {
  readonly remindAt: string;
  readonly repeatRule: ReminderRepeatRule;
  readonly allowQuietHours: boolean;
}

export type ReminderRuleSectionProps = {
  readonly state: AsyncQueryState<readonly ReminderRuleRow[]>;
  readonly onRetry: () => void;
  /** 全局总开关（设置页分区 4 的 `reminderEnabled`）——单条规则的前置闸。 */
  readonly globalEnabled: boolean;
  readonly permission: NotificationPermissionStatus | null;
  readonly onRequestPermission: () => void;
  readonly onCreate: (draft: ReminderRuleDraft) => Promise<void>;
  readonly onToggle: (ruleId: string, enabled: boolean) => Promise<void>;
};

/**
 * 对象内「提醒」区（《UI 页面规范》v0.23 §5 A，NOTIFY-001）。
 *
 * ## 它是纯展示件，取数与写回全在调用方
 *
 * 与 `AsyncState` 同一条边界：本组件**不发请求**，`state` 与三个能力
 * （`onRetry` / `onCreate` / `onToggle`）都由宿主给。这样它可以在 jsdom 里被
 * 纯数据驱动地测完四态，而 `src/shared/ui` 也不必知道提醒模块的存在。
 *
 * ## 创建行为什么在列表之外
 *
 * `AsyncState` 的空态会**整体替换** `renderSuccess` 的内容——创建行若放进去，
 * 「还没有任何规则」时用户就没有入口创建第一条（先有鸡还是先有蛋）。所以创建行
 * 与列表是并列的两块，`AsyncState` 只承担列表那三态。
 *
 * ## 「不重复」为什么没有日期输入
 *
 * §5 A 冻结文本写的是「date + time 输入」，但接口文档 §16 的 `remindAt` 只有
 * `HH:MM:SS`（用户时区本地时刻）、《数据库设计文档》§4.12 亦无日期列——日期没有
 * 写入去处，落一个会被静默丢弃的输入就是假控件（§1.1 不许假控件）。日期语义由
 * 既有物化规则承担：`daily` 取今天、`weekly` 取创建日所在星期、`none` 取创建后
 * 第一次到达该时刻的那一天（`modules/notifications/domain/reminder-schedule.ts`）。
 * 该缺口已在 RD-20260929-008 交付回执中披露，提请 UI 勘误。
 *
 * ## 总开关关闭时「禁用而非移除」
 *
 * §5 A 明文对齐分区 4 同款纪律：控件禁用而保留，用户仍能看到自己设过什么。
 * 「去开启」是**真实目标**（`/settings`），不是死入口。
 */
export function ReminderRuleSection({
  state,
  onRetry,
  globalEnabled,
  permission,
  onRequestPermission,
  onCreate,
  onToggle,
}: ReminderRuleSectionProps) {
  const toast = useToast();
  const [remindAt, setRemindAt] = useState('');
  const [repeatRule, setRepeatRule] = useState<ReminderRepeatRule>('none');
  const [allowQuietHours, setAllowQuietHours] = useState(false);
  const [creating, setCreating] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (remindAt === '' || creating) {
      return;
    }
    setCreating(true);
    setErrorMessage(null);
    try {
      // 契约要的是 `HH:MM:SS`，而 `input[type=time]` 给的是 `HH:MM`。
      await onCreate({ remindAt: `${remindAt}:00`, repeatRule, allowQuietHours });
      // 只清时刻，保留重复与豁免选择：连续加多条时它们是同一个人的同类偏好。
      setRemindAt('');
      toast.success('已添加提醒');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '保存失败，请稍后重试');
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (ruleId: string, enabled: boolean): Promise<void> => {
    if (togglingId !== null) {
      return;
    }
    setTogglingId(ruleId);
    setErrorMessage(null);
    try {
      await onToggle(ruleId, enabled);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '操作失败，请稍后重试');
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <section className={styles.section} aria-label="提醒">
      <ReminderReachNotice />

      {globalEnabled ? null : (
        <div className={styles.globalOff} data-variant="reminder-global-off">
          <p className={styles.globalOffText}>提醒总开关已关闭。</p>
          <Link className={styles.globalOffLink} href="/settings">
            去开启
          </Link>
        </div>
      )}

      <div className={styles.createRow}>
        <Input
          label="提醒时间"
          type="time"
          required
          disabled={!globalEnabled}
          value={remindAt}
          onChange={(event) => {
            setRemindAt(event.target.value);
          }}
        />

        <Select
          label="重复"
          disabled={!globalEnabled}
          value={repeatRule}
          onChange={(event) => {
            setRepeatRule(event.target.value as ReminderRepeatRule);
          }}
        >
          {REPEAT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>

        <div className={styles.checkboxRow}>
          {/*
            `Checkbox` 的可见文字由外层给：它自身的实现是"无可见文字"的列表行
            勾选框（名称走 `aria-label`），在表单里直接用它就没有可见标签。
            可见文字标 `aria-hidden`——它只是无障碍名称的视觉复制，让读屏再念
            一遍会变成"允许在安静时段提醒，允许在安静时段提醒"。
          */}
          <Checkbox
            label={QUIET_HOURS_LABEL}
            checked={allowQuietHours}
            disabled={!globalEnabled}
            onChange={setAllowQuietHours}
          />
          <span className={styles.checkboxText} aria-hidden="true">
            {QUIET_HOURS_LABEL}
          </span>
        </div>

        <Button
          variant="primary"
          loading={creating}
          disabled={!globalEnabled || remindAt === ''}
          onClick={() => {
            void submit();
          }}
        >
          保存
        </Button>
      </div>

      {errorMessage === null ? null : (
        <p className={styles.error} role="alert">
          {errorMessage}
        </p>
      )}

      <AsyncState
        state={state}
        isEmpty={(rows) => rows.length === 0}
        empty={{
          title: '还没有提醒',
          description: '在上面设好提醒时间并保存，到点后会出现在待处理提醒里。',
        }}
        errorTitle="提醒规则加载失败"
        loading={
          <div className={styles.skeleton}>
            <Skeleton height="1.25em" />
            <Skeleton height="1.25em" />
          </div>
        }
        onRetry={onRetry}
        renderSuccess={(rows) => (
          <ul className={styles.list}>
            {rows.map((row) => (
              <li className={styles.ruleRow} key={row.ruleId} data-disabled={!row.enabled}>
                <Badge variant="neutral">{REPEAT_LABELS[row.repeatRule]}</Badge>
                {row.allowQuietHours ? <Badge variant="neutral">安静时段可提醒</Badge> : null}
                {/* 「关闭＝停用该条、行转『已关闭』态可再开」（§5 A 第五项）。 */}
                {row.enabled ? null : <Badge variant="neutral">已关闭</Badge>}

                {/*
                  开关的可见标签就是这一行的时刻——它同时是无障碍名称
                  （「09:00，开关，已开启」），比另起一个"启用/停用"的名字
                  更能区分同一列表里的多条规则。
                */}
                <span className={styles.ruleSwitch}>
                  <Switch
                    label={toClock(row.remindAt)}
                    checked={row.enabled}
                    disabled={togglingId !== null}
                    onChange={(next) => {
                      void toggle(row.ruleId, next);
                    }}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      />

      <NotificationPermissionNotice
        permission={permission}
        onRequestPermission={onRequestPermission}
      />
    </section>
  );
}

/** `HH:MM:SS` → `HH:MM`（展示只到分钟，与设置页的 `time` 输入同粒度）。 */
function toClock(value: string): string {
  return value.slice(0, 5);
}
