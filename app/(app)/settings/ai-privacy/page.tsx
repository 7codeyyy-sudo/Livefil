import type { Metadata } from 'next';

import { PageHeading } from '../../_components/PageHeading';
import { SettingsColumn } from '../_components/SettingsColumn';
import { columnById } from '../_lib/columns';

export const metadata: Metadata = { title: `设置 · ${columnById('ai-privacy').name}` };

/**
 * AI 与隐私栏（`/settings/ai-privacy`；§5 分区 5 ＋ 分区 8 补齐渲染）。
 *
 * 信任内容集中一站：AI 开关与数据发送同意（分区 5），加「测试与隐私说明」
 * （分区 8——此前渲染缺失，文案取 v0.26 冻结准据逐字，见 `PrivacyNoticeSection`）。
 */
export default function AiPrivacyColumnPage() {
  return (
    <>
      <PageHeading>{columnById('ai-privacy').name}</PageHeading>
      <SettingsColumn name="ai-privacy" />
    </>
  );
}
