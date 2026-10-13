'use client';

/**
 * 设置外壳（PM-20261012-008 提案 A 两栏化；前身＝单页取数区 SettingsPanel）。
 *
 * ## 结构
 *
 * 取数区保持在**布局层**（`settings/layout.tsx` 挂载本组件）：`/me` 只取一次，
 * 7 个栏路由切换时不重新请求；`SettingsForm`（草稿 Provider）也因此跨栏存续。
 * 成功分支渲染「rail + 内容区」两栏骨架，栏页面（`children`）落进内容区。
 *
 * ## 两栏的断点
 *
 * ≥768px：rail 常驻（提案只钉了 ≥1024 与 ≤767，768–1023 的平板档按外壳
 * §3.1 断点归 rail 侧——内容区仍有 ≥500px，比退回栏列表少一次跳转）；
 * ≤767px：rail 隐藏（`display:none`，与 §3.2 流式侧栏同一处置——不留在
 * DOM 里制造屏外可聚焦链接），设置首页＝栏列表（`/settings` 索引页），
 * 栏页顶部给「‹ 设置」返回链（移动端除系统返回外的显式出口）。
 *
 * ## rail 的当前项
 *
 * 与外壳 `NavItem` 同一纪律：`aria-current` 既是语义也是样式选择器。
 * 栏 URL 是 `/settings/<段>`，所以判据必须是「等于或前缀」而不是全等——
 * 否则进入任何一栏后侧栏「设置」与 rail 都不点亮。
 */
import type { UserDto } from '@/modules/identity/application/user-dto.ts';
import { Skeleton } from '@/shared/ui/components';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { PageQuerySection } from '../_components/PageQuerySection';
import stateStyles from '../_components/StatePage.module.css';
import { PROFILE_QUERY } from '../_lib/identity-api';

import { visibleColumns } from './_lib/columns';
import { SettingsForm } from './_components/SettingsForm';
import styles from './SettingsPanel.module.css';

/** 与「设置表单」同形的轮廓：模式说明一行 + 内容分区。 */
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
 * 设置页的取数区与两栏骨架（IAM-002 → 提案 A）。
 *
 * 复用 UI-004 的 `PageQuerySection`：它已经把「查询定义 → 取数原语 → 四态容器」
 * 这段接线收好了，设置页与另外五个页面因此是同一套加载/错误行为，而不是
 * 各写一份"看起来差不多"的实现。
 */
export function SettingsPanel({ children }: { readonly children: React.ReactNode }) {
  const pathname = usePathname();

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
      renderSuccess={(envelope) => {
        const mode = envelope.data.mode;
        const columns = visibleColumns(mode);

        return (
          <SettingsForm initial={envelope.data}>
            <div className={styles.shell}>
              <aside className={styles.rail} aria-label="设置分区">
                {columns.map((column) => (
                  <Link
                    key={column.id}
                    href={column.href}
                    className={styles.railItem}
                    aria-current={pathname === column.href ? 'page' : undefined}
                  >
                    {column.name}
                  </Link>
                ))}
              </aside>

              <div className={styles.main}>
                {pathname === '/settings' ? null : (
                  <Link href="/settings" className={styles.backLink}>
                    ‹ 设置
                  </Link>
                )}
                <div className={styles.form}>
                  {/*
                    模式标识行已按终审 2026-10-13 指令移除（原 §5「页面顶部显示
                    数据模式标识」的双态句，v0.16 冻结 + UI-010 v0.26 双态化）。
                    连带悬空项归 v0.31 补节勘误：§5 该句本身、以及分区 8 隐私说明
                    第 1/2 条里「页面顶部『…』即当前状态」的引用。数据侧的 mode
                    判据不受影响（仍走 `GET /me`，账号栏与隐私双态照旧）。
                  */}
                  {children}
                </div>
              </div>
            </div>
          </SettingsForm>
        );
      }}
    />
  );
}
