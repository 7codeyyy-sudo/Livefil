import type { Metadata } from 'next';
import type { ReactNode } from 'react';

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
