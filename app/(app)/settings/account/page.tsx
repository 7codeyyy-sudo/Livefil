import type { Metadata } from 'next';

import { PageHeading } from '../../_components/PageHeading';
import { SettingsColumn } from '../_components/SettingsColumn';
import { columnById } from '../_lib/columns';

export const metadata: Metadata = { title: `设置 · ${columnById('account').name}` };

/**
 * 账号栏（`/settings/account`；§5 分区 9，**仅认证部署态渲染**）。
 *
 * 本地态直达本 URL 的重定向在 `SettingsColumn` 里（C4：本分区不存在，
 * 落到可见首栏）。首栏身份＝提案 2.2.5：侧栏「设置」入口的落点。
 */
export default function AccountColumnPage() {
  return (
    <>
      <PageHeading>{columnById('account').name}</PageHeading>
      <SettingsColumn name="account" />
    </>
  );
}
