'use client';

/**
 * 设置表单状态提供者（IAM-002 → PM-20261012-008 两栏化重构）。
 *
 * ## 它持有什么
 *
 * 一份**基线**（服务端已确认的值）与一份**草稿**（界面上正在编辑的值）。两者的
 * 差就是"未保存"的判据——不需要在每个分区里各存一份 `isDirty` 布尔，那种状态
 * 很容易在保存失败、并发修改、字段回滚之后与真实差异脱节。
 *
 * ## 为什么状态从「页面组件」升到「布局级 Provider」
 *
 * 两栏化（v0.31 候审）把设置页拆成 7 个独立 URL 后，栏与栏之间是**路由切换**：
 * 状态若留在某个栏页面里，切栏即卸载、未保存的编辑随之蒸发。把 Provider 挂在
 * `settings/layout.tsx` 下（布局在子路由切换时保持挂载），草稿与基线因此
 * **跨栏存续**——这正是提案 2.2.3「未保存态只在栏内提示」成立的前提：
 * 切栏本身不再有任何丢失，才轮得到撤掉离开确认弹窗。
 *
 * ## 为什么 `initial` 只用来初始化
 *
 * 提供者自己持有草稿之后就不再跟随 props：每次保存成功都会用响应更新基线，
 * 而重新取数（错误态重试）会重新挂载本组件。若让草稿跟着 props 走，用户在
 * 别处触发的任何刷新都会**静默丢掉**他正在输入的内容。
 *
 * ## 离开守卫已随本重构移除（提案 2.2.3 根治项）
 *
 * 原实现双路径拦截（`beforeunload` 系统框 + document 捕获阶段拦导航点击 +
 * 自绘确认弹窗），在单页 8 分区结构下制造了实测的「连环弹窗」。现在的口径：
 * 未保存态只在栏内以「未保存」徽章提示（`SettingsSection` 既有行为），
 * 栏间切换不丢草稿（见上），跨页离开与刷新不再弹任何确认。
 * 与冻结 §5「路由离开脏页须确认」的口径差待 v0.31 补节落卷时明示（PM 侧）。
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { UserDto } from '@/modules/identity/application/user-dto.ts';
import { useToast } from '@/shared/ui/components';

import { updateProfile } from '../../_lib/identity-api';

import { adoptSaved, toDraft, toProfilePatch } from './settings-draft';
import type { SectionBindings, SettingsDraft } from './settings-draft';

/** 各栏拿到的上下文：分区字段绑定 + 账号栏需要的已保存档案。 */
export type SettingsContextValue = SectionBindings & {
  /** 已保存的档案（改名后由账号栏刷新；数据管理/隐私栏读它的 `mode`）。 */
  readonly profile: UserDto;
  /** 账号栏改名成功后刷新只读行（基线即 `profile`）。 */
  readonly onProfileUpdated: (next: UserDto) => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

/**
 * 取设置上下文。
 *
 * 只能在 `settings/layout.tsx` 的 Provider 之内使用（各栏页面经
 * `SettingsColumn` 间接消费）。故意不给默认值：拿不到上下文时静默返回
 * `undefined` 会让缺失挂载这种结构性错误表现为运行期类型错误的空洞深处，
 * 直接抛错能在第一现场暴露。
 */
export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (value === null) {
    throw new Error('useSettings 必须在 <SettingsForm>（设置布局 Provider）内使用');
  }
  return value;
}

export function SettingsForm({
  initial,
  children,
}: {
  readonly initial: UserDto;
  readonly children: ReactNode;
}) {
  const [saved, setSaved] = useState<UserDto>(initial);
  const [draft, setDraft] = useState<SettingsDraft>(() => toDraft(initial));
  const toast = useToast();

  const baseline = toDraft(saved);

  const update = useCallback((patch: Partial<SettingsDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const save = useCallback(
    async (keys: readonly (keyof SettingsDraft)[]): Promise<void> => {
      const patch = toProfilePatch(draft, keys);
      // `version` 必传（乐观并发）：省略就等于"无条件覆盖"，那正是冲突要防的事。
      const { data } = await updateProfile({ ...patch, version: saved.version });

      setSaved(data);
      setDraft((current) => adoptSaved(current, keys, toDraft(data)));
      toast.success('设置已保存');
    },
    [draft, saved, toast],
  );

  const value = useMemo<SettingsContextValue>(
    () => ({ draft, baseline, update, save, profile: saved, onProfileUpdated: setSaved }),
    [draft, baseline, update, save, saved],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
