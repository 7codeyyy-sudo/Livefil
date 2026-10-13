import type { Metadata } from 'next';

import { PageHeading } from '../../_components/PageHeading';
import { SettingsColumn } from '../_components/SettingsColumn';
import { columnById } from '../_lib/columns';

export const metadata: Metadata = { title: `设置 · ${columnById('data').name}` };

/** 数据管理栏（`/settings/data`；§5 分区 7：导出、导入、回收区）。 */
export default function DataColumnPage() {
  return (
    <>
      <PageHeading>{columnById('data').name}</PageHeading>
      <SettingsColumn name="data" />
    </>
  );
}
