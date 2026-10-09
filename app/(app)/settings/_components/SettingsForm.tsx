'use client';

/**
 * 设置表单（IAM-002，《UI 页面规范》v0.16 §5）。
 *
 * ## 它持有什么
 *
 * 一份**基线**（服务端已确认的值）与一份**草稿**（界面上正在编辑的值）。两者的
 * 差就是"未保存"的判据——不需要在每个分区里各存一份 `isDirty` 布尔，那种状态
 * 很容易在保存失败、并发修改、字段回滚之后与真实差异脱节。
 *
 * ## 为什么 `initial` 只用来初始化
 *
 * 表单自己持有草稿之后就不再跟随 props：每次保存成功都会用响应更新基线，
 * 而重新取数（错误态重试）会重新挂载本组件。若让草稿跟着 props 走，用户在
 * 别处触发的任何刷新都会**静默丢掉**他正在输入的内容。
 */
import { useCallback, useState } from 'react';

import type { UserDto } from '@/modules/identity/application/user-dto.ts';
import { ConfirmDialog, useToast } from '@/shared/ui/components';

import { updateProfile } from '../../_lib/identity-api';

import {
  AiSection,
  RegionSection,
  RemindersSection,
  TaskDefaultsSection,
} from './PreferenceSections';
import { AccountSection } from './AccountSection';
import { AppearanceSection } from './AppearanceSection';
import { DataManagementSection } from './DataManagementSection';
import { LifeAreasSection } from './LifeAreasSection';
import { adoptSaved, isAnyDirty, toDraft, toProfilePatch } from './settings-draft';
import type { SectionBindings, SettingsDraft } from './settings-draft';
import { useUnsavedChangesGuard } from './settings-hooks';
import styles from './SettingsForm.module.css';

export function SettingsForm({ initial }: { readonly initial: UserDto }) {
  const [saved, setSaved] = useState<UserDto>(initial);
  const [draft, setDraft] = useState<SettingsDraft>(() => toDraft(initial));
  const toast = useToast();

  const baseline = toDraft(saved);
  const guard = useUnsavedChangesGuard(isAnyDirty(draft, baseline));

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

  const bindings: SectionBindings = { draft, baseline, update, save };

  return (
    <div className={styles.form}>
      {/*
        §5：页面顶部显示数据模式标识。用 `mode` 的真实取值渲染，而不是写死一句
        "本地模式"——云端模式接入后这里要能跟着变，写死会让那句话变成谎话。
        云端句为 UI-010 v0.26「双态句」冻结文本（本地态＝v0.16 原文零改动）；
        落卷前的旧句「数据会同步到你的账户」就地更正（RD-013 契约/UI 对照披露）。
      */}
      <p className={styles.modeNote}>
        {initial.mode === 'local'
          ? '本地模式 · 数据仅保存在本环境'
          : '云端模式 · 数据保存在云端并按账号隔离'}
      </p>

      <LifeAreasSection />
      <RegionSection {...bindings} />
      <TaskDefaultsSection {...bindings} />
      <RemindersSection {...bindings} />
      <AiSection {...bindings} />
      {/*
        外观偏好（UI-009）不吃 `bindings`：它不进服务端草稿，而是本机即时生效的
        客户端偏好（见 `AppearanceSection` 文件说明）。
      */}
      <AppearanceSection />
      {/*
        数据管理分区 7（OPS-002，v0.26 分区 7）：导出/导入/回收区三块；
        删除块本批不渲染（契约缺口，总监 2026-10-09 裁定，RD-015 披露）。
        说明行走 `mode` 双态（冻结句由 `GET /me` 驱动）。
      */}
      <DataManagementSection mode={saved.mode === 'cloud' ? 'cloud' : 'local'} />
      {/*
        账号分区（AUTH-002，v0.26 分区 9）：**仅认证态渲染**（C4——本地自用态
        本分区不存在，原「云端账号区挂账」句由兑现注记承接）。传 `saved` 而非
        `initial`：改名成功后只读行要跟着刷新，基线就是 saved。
      */}
      {saved.mode === 'cloud' ? (
        <AccountSection profile={saved} onProfileUpdated={setSaved} />
      ) : null}

      {/*
        脏页离开确认。用组件库的确认弹窗而不是 `window.confirm`：后者会阻塞
        主线程、样式不可控，而且在自动化测试里需要处理原生对话框。
      */}
      <ConfirmDialog
        open={guard.pendingLeave}
        title="离开设置页？"
        description="还有未保存的修改。现在离开会丢失它们。"
        confirmLabel="放弃修改并离开"
        destructive
        onCancel={guard.cancelLeave}
        onConfirm={guard.confirmLeave}
      />
    </div>
  );
}
