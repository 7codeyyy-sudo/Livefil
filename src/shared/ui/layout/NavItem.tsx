'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import type { NavItemDefinition } from './nav-items';

import styles from './NavItem.module.css';

export type NavItemProps = NavItemDefinition & {
  /**
   * 点击导航项时触发。**只有移动端抽屉会传**。
   *
   * 存在的理由是一个真实缺陷：抽屉是**浮层**，点击里面的链接会完成路由切换，
   * 但没有任何东西会因此关掉抽屉——于是新页面被抽屉与遮罩盖着、`body` 的滚动
   * 还锁着，用户必须先按一次 ESC 才能看到自己刚点开的页面。抽屉把这里接到
   * 自己的 `onClose` 上就解决了。
   *
   * 流式侧栏**不传**：桌面/平板下切换路由后侧栏本就该留着。
   */
  readonly onClick?: (() => void) | undefined;
};

/**
 * 单个导航项（UI-003）。
 *
 * ## 为什么必须自己读 `usePathname`，而不是由父级传 `isCurrent`
 *
 * 导航项出现在**两个**渲染位置（流式侧栏与移动端抽屉），而它们各自的父级
 * 都不掌握"当前路由"。如果改成父级传参，两处的父级就得各写一遍同样的
 * 判断——同一份逻辑写两遍，正是本批把导航清单抽成单一来源要避免的那类问题。
 *
 * ## 当前页状态只有一个来源
 *
 * `aria-current="page"` 既是**无障碍语义**，也是**样式的选择器**（见
 * `NavItem.module.css`）。用同一个属性做两件事，就不会出现"视觉高亮了、
 * 读屏没读出来"这种两套判据各自漂移的情况。SRS §6.9 要求状态不只靠颜色
 * 区分，这也正好满足：除了底色，当前项还有 `aria-current` 与更重的字重。
 *
 * ## `onClick` 为什么不能由父级"统一包一层"代替
 *
 * 父级确实可以套一个 `onClick` 到每个链接上，但那要求父级知道"哪些子元素是
 * 链接"——`SidebarContent` 里除了导航项还有品牌链接，套漏一个就复现同一个
 * 缺陷。让**每个链接自己**接收并转发，漏不掉。
 */
export function NavItem({ href, label, onClick }: NavItemProps) {
  const pathname = usePathname();
  const isCurrent = pathname === href;

  // 按需展开，而不是 `onClick={onClick}`：`exactOptionalPropertyTypes` 下把
  // `undefined` 显式传给 `Link` 的 `onClick` 不合法——Next 的类型是
  // `MouseEventHandler`，不接受 `| undefined`。
  const clickProps = onClick === undefined ? {} : { onClick };

  return (
    <Link
      href={href}
      {...clickProps}
      className={styles.item}
      aria-current={isCurrent ? 'page' : undefined}
    >
      {label}
    </Link>
  );
}
