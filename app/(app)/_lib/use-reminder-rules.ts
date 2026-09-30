'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  AsyncQueryState,
  ReminderRepeatRule,
  ReminderRuleDraft,
  ReminderRuleRow,
} from '@/shared/ui/components';
import type { NotificationPermissionStatus } from '@/shared/ui/components';

import { fetchProfile } from './identity-api';
import {
  createNotificationRule,
  fetchRulesForTargetType,
  updateNotificationRule,
} from './notifications-api';
import type { NotificationRuleItem, NotificationTargetType } from './notifications-api';
import { useNotificationPermission } from './use-notification-permission';

export type ReminderRuleStore = {
  /**
   * 设置页分区 4 的提醒总开关（`users.reminderEnabled`）——单条规则的前置闸。
   *
   * `null` 表示**尚未测定**（加载中或取数失败），刻意不默认 `true` / `false`：
   * 把「还不知道」当成「已关闭」就是一句假话，用户会去设置页找一个根本没关的开关。
   */
  readonly globalEnabled: boolean | null;
  readonly permission: NotificationPermissionStatus | null;
  readonly requestPermission: () => void;
  /** 取某对象的规则行状态；`loading` / `error` 与那次列表查询同态。 */
  readonly stateFor: (
    targetType: NotificationTargetType,
    targetId: string,
  ) => AsyncQueryState<readonly ReminderRuleRow[]>;
  readonly retry: () => void;
  readonly createRule: (
    targetType: NotificationTargetType,
    targetId: string,
    draft: ReminderRuleDraft,
  ) => Promise<void>;
  readonly toggleRule: (ruleId: string, enabled: boolean) => Promise<void>;
};

/**
 * 一次列表取数的**落定**结果。
 *
 * 刻意不含 `loading`：`loading` 是「还没有落定结果」的派生态（见 `snapshots`），
 * 把它塞进这里会逼着每一处消费点再判别一次「不该存在的 loading」。
 */
type SettledRules = {
  readonly requestId: string;
  readonly state:
    | { readonly status: 'success'; readonly data: readonly NotificationRuleItem[] }
    | { readonly status: 'error'; readonly error: Error };
};

/** 某个 `targetType` 的切片视图：成功时按 `targetId` 分好组。 */
type TypeSnapshot =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: Error }
  | {
      readonly status: 'success';
      readonly byTargetId: ReadonlyMap<string, readonly ReminderRuleRow[]>;
    };

/**
 * 对象内提醒规则的页面级取数（《UI 页面规范》v0.23 §5 A 的三个宿主共用）。
 *
 * ## 为什么不用 `useAsyncQuery`
 *
 * 它没有 `enabled` 选项，且每次调用都要一个 `queryKey`——本 hook 需要「一次请求
 * 喂给几十个对象行」，那正好是 `useAsyncQuery` 表达不了的形态（逐行调用＝N+1）。
 * 这里自己实现同一套「三态 + 手动重试」，但不把 `EmptyState` 之类的业务判断
 * 也拉进来。
 *
 * ## 取数纪律
 *
 * 每个 `targetType` 只发**一次** `GET /notification-rules?targetType=…`，返回的规则
 * 按 `targetId` 建 Map；`stateFor` 从 Map 里切出该对象那一行。`targetTypes` 用
 * `join(',')` 的稳定串进依赖——数组身份每次渲染都变，会让取数每帧重发。
 */
export function useReminderRuleStore(
  targetTypes: readonly NotificationTargetType[],
): ReminderRuleStore {
  // 整页只调一次：`useNotificationPermission` 每个实例都会挂一个 `visibilitychange`
  // 监听，逐行调用会在几十行列表上累积几十个监听。
  const { permission, requestPermission } = useNotificationPermission();

  const key = targetTypes.join(',');
  const [globalEnabled, setGlobalEnabled] = useState<boolean | null>(null);
  const [rulesVersion, setRulesVersion] = useState(0);
  const [settled, setSettled] = useState<ReadonlyMap<string, SettledRules>>(new Map());

  // 总开关（`GET /me`）：只取一次，与 `ReviewReminderArea` 同款。
  useEffect(() => {
    const controller = new AbortController();
    fetchProfile(controller.signal)
      .then((envelope) => {
        if (controller.signal.aborted) {
          return;
        }
        setGlobalEnabled(envelope.data.reminderEnabled);
      })
      .catch(() => {
        // 失败时**不**写 `false`：那会把「还不知道」谎报成「总开关已关闭」
        // （同 ReviewReminderArea）。保持初值 `null`，由宿主决定不渲染入口。
        // 这里不 setState 是刻意的——它本来就是 `null`，再写一次只会多一轮渲染。
      });
    return () => {
      controller.abort();
    };
  }, []);

  const requestId = `${key}#${String(rulesVersion)}`;

  useEffect(() => {
    const controllers: AbortController[] = [];

    for (const targetType of splitTargetTypes(key)) {
      const controller = new AbortController();
      controllers.push(controller);

      fetchRulesForTargetType(targetType, controller.signal)
        .then((envelope) => {
          if (controller.signal.aborted) {
            return;
          }
          setSettled((previous) =>
            new Map(previous).set(targetType, {
              requestId,
              state: { status: 'success', data: envelope.data },
            }),
          );
        })
        .catch((cause: unknown) => {
          // abort 不是失败（key 变化或卸载都会走到这里），记成错误会让用户看到
          // 一次莫名其妙的「加载失败」。
          if (controller.signal.aborted) {
            return;
          }
          setSettled((previous) =>
            new Map(previous).set(targetType, {
              requestId,
              state: { status: 'error', error: toError(cause) },
            }),
          );
        });
    }

    return () => {
      for (const controller of controllers) {
        controller.abort();
      }
    };
  }, [key, requestId]);

  const snapshots = useMemo(() => {
    const map = new Map<string, TypeSnapshot>();

    for (const targetType of splitTargetTypes(key)) {
      const entry = settled.get(targetType);
      // 「正在加载」是**派生**出来的：只要手头的结果不属于当前请求，就还没有结果。
      if (entry === undefined || entry.requestId !== requestId) {
        map.set(targetType, { status: 'loading' });
        continue;
      }
      map.set(
        targetType,
        entry.state.status === 'success'
          ? { status: 'success', byTargetId: groupByTargetId(entry.state.data) }
          : { status: 'error', error: entry.state.error },
      );
    }

    return map;
  }, [key, requestId, settled]);

  const stateFor = useCallback(
    (
      targetType: NotificationTargetType,
      targetId: string,
    ): AsyncQueryState<readonly ReminderRuleRow[]> => {
      const snapshot = snapshots.get(targetType);
      if (snapshot === undefined || snapshot.status === 'loading') {
        return { status: 'loading' };
      }
      if (snapshot.status === 'error') {
        return { status: 'error', error: snapshot.error };
      }
      // 该对象一条规则都没有 → 成功但为空，交给 `AsyncState` 走空态。
      return { status: 'success', data: snapshot.byTargetId.get(targetId) ?? [] };
    },
    [snapshots],
  );

  const refetch = useCallback(() => {
    setRulesVersion((current) => current + 1);
  }, []);

  const createRule = useCallback(
    async (
      targetType: NotificationTargetType,
      targetId: string,
      draft: ReminderRuleDraft,
    ): Promise<void> => {
      await createNotificationRule({
        targetType,
        targetId,
        remindAt: draft.remindAt,
        repeatRule: draft.repeatRule,
        allowQuietHours: draft.allowQuietHours,
      });
      // 成功后重取该类规则：行内列表要立刻看到刚建的那条。
      refetch();
    },
    [refetch],
  );

  const toggleRule = useCallback(
    async (ruleId: string, enabled: boolean): Promise<void> => {
      await updateNotificationRule(ruleId, { enabled });
      refetch();
    },
    [refetch],
  );

  return {
    globalEnabled,
    permission,
    requestPermission,
    stateFor,
    retry: refetch,
    createRule,
    toggleRule,
  };
}

/** 稳定串 `'task,routine'` → 目标类型数组（空串＝没有要取的类）。 */
function splitTargetTypes(key: string): readonly NotificationTargetType[] {
  return key === '' ? [] : (key.split(',') as NotificationTargetType[]);
}

/** §16 规则载荷按 `targetId` 分组成行；`review` 类（`targetId === null`）不属任何对象行。 */
function groupByTargetId(
  items: readonly NotificationRuleItem[],
): ReadonlyMap<string, readonly ReminderRuleRow[]> {
  const grouped = new Map<string, ReminderRuleRow[]>();

  for (const item of items) {
    if (item.targetId === null) {
      continue;
    }
    const row = toRuleRow(item);
    const rows = grouped.get(item.targetId);
    if (rows === undefined) {
      grouped.set(item.targetId, [row]);
    } else {
      rows.push(row);
    }
  }

  return grouped;
}

/**
 * §16 规则载荷 → 区块行。
 *
 * 与 `ReviewReminderArea` 的同名映射同源：两处都只是「契约字段 → 展示字段」的
 * 忠实搬运，不在这里做任何业务判断。
 */
function toRuleRow(item: NotificationRuleItem): ReminderRuleRow {
  return {
    ruleId: item.ruleId,
    remindAt: item.remindAt,
    repeatRule: toRepeatRule(item.repeatRule),
    allowQuietHours: item.allowQuietHours,
    enabled: item.enabled,
  };
}

/** 重复规则取值兜底：越界值按「不重复」呈现，不因一个未知枚举炸掉整个区块。 */
function toRepeatRule(value: string): ReminderRepeatRule {
  if (value === 'daily' || value === 'weekly') {
    return value;
  }
  return 'none';
}

/** 把任意抛出物归一成 `Error`（`AsyncState` 要读 `error.message`）。 */
function toError(cause: unknown): Error {
  if (cause instanceof Error) {
    return cause;
  }
  if (typeof cause === 'string') {
    return new Error(cause);
  }
  return new Error('提醒规则加载失败');
}
