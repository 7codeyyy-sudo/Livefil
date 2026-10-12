import type { Metadata } from 'next';

import { PageHeading } from '../../_components/PageHeading';
import { SettingsColumn } from '../_components/SettingsColumn';
import { columnById } from '../_lib/columns';

export const metadata: Metadata = { title: `设置 · ${columnById('appearance').name}` };

/** 外观栏（`/settings/appearance`；§5 分区 6，即时生效、无保存动作）。 */
export default function AppearanceColumnPage() {
  return (
    <>
      <PageHeading>{columnById('appearance').name}</PageHeading>
      <SettingsColumn name="appearance" />
    </>
  );
}
