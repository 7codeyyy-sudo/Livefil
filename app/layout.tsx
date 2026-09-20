import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { ToastProvider } from '@/shared/ui/components';
// 设计令牌的**唯一导入点**（UI-001）：全局样式只在根布局引入一次。
// 各页面与组件通过 CSS Modules 消费其中的变量，不再单独引入本文件。
import '@/shared/ui/styles/tokens.css';
// 全局重置（UI-003）。必须在令牌之后：它引用令牌值做基础排版，
// 且 `box-sizing: border-box` 要能影响所有页面的默认盒模型。
import './globals.css';
import { clientEnv } from '@/shared/validation/env.client';

export const metadata: Metadata = {
  // 各页只写自己的短标题（`export const metadata = { title: '今日' }`），
  // 模板在这里统一拼上产品名——这样「文档标题与页面标题同步」不必在
  // 六个页面里各写一遍产品名，改名时也只改一处。
  title: {
    default: clientEnv.appName,
    template: `%s · ${clientEnv.appName}`,
  },
  description: '个人生活管理与自律系统',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {/* 全局提示通道挂在根布局：这样「最多 3 条」才是全站范围的上限，
            而不是每个页面各自 3 条；提示条也必须浮在所有页面内容与浮层之上。 */}
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
