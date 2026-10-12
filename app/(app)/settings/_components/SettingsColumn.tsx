'use client';

/**
 * 栏内容分发器（PM-20261012-008 提案 A 2.1 栏-分区映射表的代码侧）。
 *
 * 各栏页面是服务端组件（要导出 `metadata`），而分区组件全部是客户端组件
 * 且需要 `useSettings()` 的字段绑定——服务端组件不能把函数当 props 传下去，
 * 所以每栏页面把**可序列化的栏 id** 交给本组件，由它在客户端侧取出对应的
 * 分区组合。映射集中在一处，改映射不会漏改某个页面。
 *
 * 分区组件本身零改动：它们照旧接收 `SectionBindings`，字段集、冻结文案与
 * 校验行为逐字未动（提案 2.2.4 的「改造面＝容器、导航、路由、布局」）。
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import type { SettingsColumnId } from '../_lib/columns';
import { firstVisibleColumn } from '../_lib/columns';

import { AccountSection } from './AccountSection';
import { AppearanceSection } from './AppearanceSection';
import { DataManagementSection } from './DataManagementSection';
import { LifeAreasSection } from './LifeAreasSection';
import {
  AiSection,
  RegionSection,
  RemindersSection,
  TaskDefaultsSection,
} from './PreferenceSections';
import { PrivacyNoticeSection } from './PrivacyNoticeSection';
import { useSettings } from './SettingsForm';

export function SettingsColumn({ name }: { readonly name: SettingsColumnId }) {
  const { draft, baseline, update, save, profile, onProfileUpdated } = useSettings();
  const router = useRouter();

  // 账号栏仅认证部署态存在（§5 分区 9 / C4「本地自用态本分区不存在」）：
  // local 态下直达 `/settings/account` 时重定向到可见首栏，不渲染空栏。
  const accountMissing = name === 'account' && profile.mode !== 'cloud';
  useEffect(() => {
    if (accountMissing) {
      router.replace(firstVisibleColumn(profile.mode).href);
    }
  }, [accountMissing, router, profile.mode]);

  if (accountMissing) {
    return null;
  }

  const bindings = { draft, baseline, update, save };

  switch (name) {
    case 'account':
      return <AccountSection profile={profile} onProfileUpdated={onProfileUpdated} />;
    case 'appearance':
      return <AppearanceSection />;
    case 'notifications':
      return <RemindersSection {...bindings} />;
    case 'ai-privacy':
      return (
        <>
          <AiSection {...bindings} />
          {/* 分区 8「测试与隐私说明」补渲染：归 AI 与隐私栏（提案 2.1 第 4 栏）。 */}
          <PrivacyNoticeSection />
        </>
      );
    case 'data':
      return <DataManagementSection mode={profile.mode === 'cloud' ? 'cloud' : 'local'} />;
    case 'life-areas':
      return <LifeAreasSection />;
    case 'general':
      return (
        <>
          <RegionSection {...bindings} />
          <TaskDefaultsSection {...bindings} />
        </>
      );
  }

  // 走到这里只可能是清单加了新栏却忘了更新本映射——显式失败优于静默渲染空栏。
  return null;
}
