import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { ToastProvider } from '@/shared/ui/components';
// 设计令牌的**唯一导入点**（UI-001）：全局样式只在根布局引入一次。
// 各页面与组件通过 CSS Modules 消费其中的变量，不再单独引入本文件。
import '@/shared/ui/styles/tokens.css';
// 全局重置（UI-003）。必须在令牌之后：它引用令牌值做基础排版，
// 且 `box-sizing: border-box` 要能影响所有页面的默认盒模型。
import './globals.css';
import { THEME_STORAGE_KEY } from '@/shared/ui/theme/theme-storage';
import { clientEnv } from '@/shared/validation/env.client';

/**
 * 防闪引导脚本（UI-012）：首帧前把本地主题偏好落到 `<html data-theme>`。
 *
 * ## 为什么必须是内联脚本，而不是等 React 水合
 *
 * 水合发生在首帧之后：暗色用户会先看到一帧已验收的浅色再翻转（闪烁）。
 * 内联脚本在解析期执行，早于首次绘制，属性落定后第一帧就是正确主题。
 *
 * ## 为什么它不能复用 `src/shared/ui/theme/` 的应用函数
 *
 * 内联脚本要求**自包含**（不能 import）；因此它是 `data-theme` 的两处白名单
 * 设置点之一（另一处是 `theme-apply.ts`），由 `ui-001-acceptance.mjs` 的
 * 「设置点白名单」断言守住。只认两档合法值：非法/缺失时不动属性，
 * 与 `readTheme()` 的兜底口径一致（默认浅色）。
 */
const themeBootstrapScript = `(function(){try{var t=window.localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

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
        {/* 防闪引导脚本：必须是 body 的**第一个**节点——此后所有内容都在
            它之后解析，第一帧绘制时主题属性已经落定（见上方说明）。 */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        {/* 全局提示通道挂在根布局：这样「最多 3 条」才是全站范围的上限，
            而不是每个页面各自 3 条；提示条也必须浮在所有页面内容与浮层之上。 */}
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
