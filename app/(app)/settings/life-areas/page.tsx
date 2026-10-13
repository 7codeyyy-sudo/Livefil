import type { Metadata } from 'next';

import { PageHeading } from '../../_components/PageHeading';
import { SettingsColumn } from '../_components/SettingsColumn';
import { columnById } from '../_lib/columns';

export const metadata: Metadata = { title: `设置 · ${columnById('life-areas').name}` };

/**
 * 生活领域栏（`/settings/life-areas`；§5 分区 1）。
 *
 * 提案 B 的双场景入口（开销页「管理分类」旁、安排弹层领域选择器旁）
 * 统一落点到这里——领域本身不搬家（提案 3.2 边界）。
 */
export default function LifeAreasColumnPage() {
  return (
    <>
      <PageHeading>{columnById('life-areas').name}</PageHeading>
      <SettingsColumn name="life-areas" />
    </>
  );
}
