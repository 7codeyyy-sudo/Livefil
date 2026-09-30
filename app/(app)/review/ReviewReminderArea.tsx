'use client';

import { useState } from 'react';

import {
  Button,
  ErrorState,
  LoadingState,
  ReminderRuleSection,
  Skeleton,
  useAsyncQuery,
} from '@/shared/ui/components';
import type { AsyncQueryState, ReminderRuleDraft, ReminderRuleRow } from '@/shared/ui/components';

import { fetchProfile } from '../_lib/identity-api';
import {
  createNotificationRule,
  fetchRulesForReview,
  updateNotificationRule,
} from '../_lib/notifications-api';
import type { NotificationRuleItem } from '../_lib/notifications-api';
import { useNotificationPermission } from '../_lib/use-notification-permission';

import styles from './ReviewReminderArea.module.css';

/**
 * 复盘提醒区（《UI 页面规范》v0.23 §5 A 的 `/review` 宿主）。
 *
 * ## 为什么是"页内按钮展开"而不是行内展开
 *
 * §5 A 的三处宿主里，任务行与例程行是**行内**展开（挂在该行正下方），而这一处
 * 明文是「页内『提醒』按钮展开的区内区域」——复盘没有"行"可挂（日/周复盘是同一
 * 页里的两段，不是列表项），所以入口是一枚页内「提醒」按钮，点击在按钮下方展开
 * 区域。再次点击（或展开区里没有第二重入口）折叠。
 *
 * ## 为什么复盘规则没有对象 id
 *
 * §16 明文：`review` 类 `targetId` **必须省略**（周复盘提醒不绑定单条实体，服务端
 * 落 `NULL`）。所以本区只查/建 `targetType=review` 一类规则，不拼 `targetId`。
 *
 * ## 总开关为何要单独取一次
 *
 * 规则能否创建取决于设置页分区 4 的总开关（`users.reminderEnabled`），而 A 节要求
 * 「创建控件禁用而非移除」。这里没有把 `reminderEnabled` 塞进规则列表的返回里
 * ——§16 没有这个字段，硬造一个就偏离了契约；多一次 `GET /me` 是明确且便宜的代价。
 *
 * 加载与失败不静默降级成"已关闭"：把"还不知道"渲染成"总开关已关闭"就是一句
 * 假话，用户会去设置页找一个根本没关的开关。
 */
export function ReviewReminderArea() {
  const [open, setOpen] = useState(false);
  const { permission, requestPermission } = useNotificationPermission();

  const profile = useAsyncQuery({
    queryKey: ['me', 'reminder-gate'],
    queryFn: fetchProfile,
  });

  const rules = useAsyncQuery({
    queryKey: ['notification-rules', 'review'],
    queryFn: (signal) => fetchRulesForReview(signal),
  });

  const refetchRules = rules.refetch;

  const sectionState: AsyncQueryState<readonly ReminderRuleRow[]> =
    rules.state.status === 'success'
      ? { status: 'success', data: toRuleRows(rules.state.data.data) }
      : rules.state;

  return (
    <div className={styles.area}>
      <div className={styles.toolbar}>
        <Button
          variant="ghost"
          aria-expanded={open}
          aria-controls="review-reminder-area"
          onClick={() => {
            setOpen((current) => !current);
          }}
        >
          提醒
        </Button>
      </div>

      {open ? (
        <div id="review-reminder-area" className={styles.section}>
          {profile.state.status === 'loading' ? (
            <LoadingState>
              <div className={styles.skeleton}>
                <Skeleton height="1.25em" />
                <Skeleton height="1.25em" />
              </div>
            </LoadingState>
          ) : profile.state.status === 'error' ? (
            <ErrorState
              title="提醒状态没能加载"
              description="没取到提醒总开关的状态，暂时不知道能不能新建提醒。"
              action={
                <Button variant="primary" onClick={profile.refetch}>
                  重试
                </Button>
              }
            />
          ) : (
            <ReminderRuleSection
              state={sectionState}
              onRetry={refetchRules}
              globalEnabled={profile.state.data.data.reminderEnabled}
              permission={permission}
              onRequestPermission={requestPermission}
              onCreate={async (draft: ReminderRuleDraft) => {
                await createNotificationRule({
                  targetType: 'review',
                  targetId: null,
                  remindAt: draft.remindAt,
                  repeatRule: draft.repeatRule,
                  allowQuietHours: draft.allowQuietHours,
                });
                refetchRules();
              }}
              onToggle={async (ruleId: string, enabled: boolean) => {
                await updateNotificationRule(ruleId, { enabled });
                refetchRules();
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** §16 规则载荷 → 区块行。 */
function toRuleRows(items: readonly NotificationRuleItem[]): readonly ReminderRuleRow[] {
  return items.map((item) => ({
    ruleId: item.ruleId,
    remindAt: item.remindAt,
    repeatRule: toRepeatRule(item.repeatRule),
    allowQuietHours: item.allowQuietHours,
    enabled: item.enabled,
  }));
}

/** 重复规则取值兜底：越界值按「不重复」呈现，不因一个未知枚举炸掉整个区块。 */
function toRepeatRule(value: string): ReminderRuleRow['repeatRule'] {
  if (value === 'daily' || value === 'weekly') {
    return value;
  }
  return 'none';
}
