import type { Metadata } from 'next';

import { PageHeading } from '../_components/PageHeading';

import { SettingsIndex } from './_components/SettingsIndex';

export const metadata: Metadata = { title: '设置' };

/**
 * 设置索引（`/settings`；IAM-002 → PM-20261012-008 提案 A 两栏化）。
 *
 * 页面本身保持 RSC：它只出标题与 metadata，视口判定与栏列表在客户端子组件里。
 * 同一 URL 按视口分饰两角——移动端＝栏列表（设置首页），桌面端＝重定向到首栏
 * （旧 `/settings` 书签兼容）——判定口径见 `SettingsIndex` 文件头。
 *
 * 数据导出与账户删除**不在这里**（分区 7/9 各归其栏）。
 */
export default function SettingsPage() {
  return (
    <>
      <PageHeading>设置</PageHeading>
      <SettingsIndex />
    </>
  );
}
