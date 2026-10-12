import type { Metadata } from 'next';

import { PageHeading } from '../../_components/PageHeading';
import { SettingsColumn } from '../_components/SettingsColumn';
import { columnById } from '../_lib/columns';

export const metadata: Metadata = { title: `设置 · ${columnById('general').name}` };

/**
 * 通用栏（`/settings/general`；§5 分区 2 地区与语言 ＋ 分区 3 任务默认值——
 * 两个低频轻页合并，避免碎栏（提案 2.1 第 7 栏））。
 */
export default function GeneralColumnPage() {
  return (
    <>
      <PageHeading>{columnById('general').name}</PageHeading>
      <SettingsColumn name="general" />
    </>
  );
}
