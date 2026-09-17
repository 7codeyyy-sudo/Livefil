import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// 设计令牌的**唯一导入点**（UI-001）：全局样式只在根布局引入一次。
// 各页面与组件通过 CSS Modules 消费其中的变量，不再单独引入本文件。
import '@/shared/ui/styles/tokens.css';
import { clientEnv } from '@/shared/validation/env.client';

export const metadata: Metadata = {
  title: clientEnv.appName,
  description: '个人生活管理与自律系统',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
