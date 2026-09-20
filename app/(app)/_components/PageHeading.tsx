import type { ReactNode } from 'react';

import styles from './PageHeading.module.css';

export type PageHeadingProps = {
  readonly children: ReactNode;
};

/**
 * 页面标题（UI-004）。
 *
 * ## 为什么单独成组件
 *
 * 五个状态页与一个占位页都要这一行 `<h1>`。写在每一页里，等于把「页标题用哪档
 * 字号、什么颜色」复制成六份；`PlaceholderPage` 原本自带一份同样的样式，
 * 这里收成一处，两边都引用它（**注意**：`<h1>` 是页面语义的一部分，
 * 不是可以随手换的排版细节）。
 *
 * ## 为什么它自己是服务端组件
 *
 * 标题是静态文本，没有任何状态。页面保持 RSC，只有真正需要取数的那个子区块
 * 是客户端组件——这样取数逻辑与文案不会把整页拖进客户端包。
 */
export function PageHeading({ children }: PageHeadingProps) {
  return <h1 className={styles.heading}>{children}</h1>;
}
