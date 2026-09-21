import type { Metadata } from 'next';

import { PageHeading } from '../_components/PageHeading';

import { SettingsPanel } from './SettingsPanel';

export const metadata: Metadata = { title: '设置' };

/**
 * 设置页（`/settings`，IAM-002，《UI 页面规范》v0.16 §5）。
 *
 * 页面本身保持 RSC：它只出标题与 metadata，取数与表单都在客户端子组件里。
 * 这样服务端渲染的首屏就包含标题，而表单的水合边界收在最里面那一层。
 *
 * 数据导出与账户删除**不在这里**（属 `data-management` 批次），也**不放假按钮**
 * （§5 明文）。规范里"五分区"的清单就是本页的全部内容。
 */
export default function SettingsPage() {
  return (
    <>
      <PageHeading>设置</PageHeading>
      <SettingsPanel />
    </>
  );
}
