import type { CSSProperties, ReactNode } from 'react';

import styles from './PageHeading.module.css';

export type PageHeadingProps = {
  readonly children: ReactNode;
};

/**
 * 页面标题（UI-004；UI-011 起带逐字 SplitText 入场）。
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
 *
 * ## 逐字动画为什么拆在组件内（UI-011 §6.1）
 *
 * 纯字符串 children 按字符拆成 `span.ch`，每个字带 `--i` 序号，CSS 端用
 * `calc(var(--i) * var(--duration-base))` 做错峰——时长与错峰全部由令牌派生，
 * 组件里没有一个字面量。拆字生成的是**数组**，React 渲染数组不会插入空白
 * 节点，所以 `textContent` 仍是原标题（既有测试断言 `toHaveText('今日')` 不受影响）。
 * 非字符串 children（罕见，当前八个消费点全是纯文本）走原样兜底，不做拆字。
 */
export function PageHeading({ children }: PageHeadingProps) {
  if (typeof children !== 'string') {
    return <h1 className={styles.heading}>{children}</h1>;
  }

  const characters = Array.from(children);

  return (
    <h1 className={styles.heading}>
      {characters.map((character, index) => (
        <span
          // 拆字 span 只承载动画，无独立语义；aria-label 归 h1 整体读屏。
          key={`${character}-${index}`}
          className={styles.ch}
          style={{ '--i': index } as CSSProperties}
        >
          {character}
        </span>
      ))}
    </h1>
  );
}
