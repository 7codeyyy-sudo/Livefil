/**
 * 设置布局（PM-20261012-008 提案 A 两栏化的挂载点）。
 *
 * 布局在子路由（7 个栏 URL）切换时**保持挂载**——这是两处关键行为的地基：
 * ① `/me` 取数与草稿 Provider 只初始化一次，切栏不重新请求、不丢未保存编辑；
 * ② rail 与返回链跨栏常驻，栏页面只贡献自己的内容。
 */
import type { ReactNode } from 'react';

import { SettingsPanel } from './SettingsPanel';

export default function SettingsLayout({ children }: { readonly children: ReactNode }) {
  return <SettingsPanel>{children}</SettingsPanel>;
}
