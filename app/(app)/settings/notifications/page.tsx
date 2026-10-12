import type { Metadata } from 'next';

import { PageHeading } from '../../_components/PageHeading';
import { SettingsColumn } from '../_components/SettingsColumn';
import { columnById } from '../_lib/columns';

export const metadata: Metadata = { title: `设置 · ${columnById('notifications').name}` };

/**
 * 提醒与通知栏（`/settings/notifications`；§5 分区 4）。
 *
 * 栏名由「提醒与安静时段」扩为「提醒与通知」（提案 2.1 第 3 栏），收纳口径不变。
 */
export default function NotificationsColumnPage() {
  return (
    <>
      <PageHeading>{columnById('notifications').name}</PageHeading>
      <SettingsColumn name="notifications" />
    </>
  );
}
