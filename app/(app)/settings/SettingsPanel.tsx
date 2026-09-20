'use client';

import type { UserDto } from '@/modules/identity/application/user-dto.ts';
import { Skeleton } from '@/shared/ui/components';

import { PageQuerySection } from '../_components/PageQuerySection';
import stateStyles from '../_components/StatePage.module.css';
import { PROFILE_QUERY } from '../_lib/identity-api';

import { SettingsForm } from './_components/SettingsForm';

/** 与「设置表单」同形的轮廓：模式说明一行 + 三个分区块。 */
function SettingsSkeleton() {
  return (
    <div className={stateStyles.skeleton}>
      <Skeleton width="30%" />
      <Skeleton height="120px" />
      <Skeleton height="120px" />
      <Skeleton height="120px" />
    </div>
  );
}

/**
 * 设置页的取数区（IAM-002）。
 *
 * 复用 UI-004 的 `PageQuerySection`：它已经把「查询定义 → 取数原语 → 四态容器」
 * 这段接线收好了，设置页与另外五个页面因此是同一套加载/错误行为，而不是
 * 各写一份"看起来差不多"的实现。
 */
export function SettingsPanel() {
  return (
    <PageQuerySection<UserDto>
      query={PROFILE_QUERY}
      errorTitle="设置没能加载"
      errorDescription="偏好设置没能取回来。可以先重试。"
      skeleton={<SettingsSkeleton />}
      /*
       * `/me` 永远返回一个对象（本地模式下没有会话就自动建用户），所以这个空态
       * 分支**不可达**——`PROFILE_QUERY.isEmpty` 恒为 false。仍然给出真实文案而
       * 不是留一句占位废话：万一将来它变得可达（例如云端模式下账户被注销），
       * 用户看到的应当是一句能读懂的说明。
       */
      empty={{
        title: '还没有可显示的设置',
        description: '当前账户还没有偏好设置，保存任意一项后就会出现在这里。',
      }}
      renderSuccess={(envelope) => <SettingsForm initial={envelope.data} />}
    />
  );
}
