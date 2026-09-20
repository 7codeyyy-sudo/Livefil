'use client';

import Link from 'next/link';

import { clientEnv } from '@/shared/validation/env.client';

import { NavItem } from './NavItem';
import { PRIMARY_NAV_ITEMS, SETTINGS_NAV_ITEM } from './nav-items';
import { useTodayLabel } from './use-today-label';

import styles from './SidebarContent.module.css';

export type SidebarContentProps = {
  /**
   * 导航发生后通知调用方。**只有移动端抽屉会传**（接到它自己的 `onClose`）。
   *
   * 抽屉是浮层，路由切换不会自动关掉它；不接这条线的话新页面会被抽屉与遮罩
   * 盖着、滚动还锁着。流式侧栏不传——桌面/平板切换路由后侧栏本就该留着。
   *
   * 注意这里**所有**指向站内的链接都要接上，不只是导航项：品牌链接同样会
   * 切到 `/today`，漏掉它就等于留下同一个缺陷的另一条入口。
   */
  readonly onNavigate?: (() => void) | undefined;
};

/**
 * 侧栏内容（UI-003）。
 *
 * ## 为什么内容单独成一个组件
 *
 * 同一套导航出现在**两个**渲染位置：桌面/平板的流式侧栏，和移动端由汉堡
 * 唤出的抽屉。原型的做法是「同一个 `.sidebar` 元素，窄屏改成 fixed 位移」，
 * 但那要求导航内容始终留在 DOM 里——而本批的移动端抽屉是**浮层**（关闭时
 * 整个卸载，见 `MobileNavDrawer`），两者不能共用同一个 DOM 节点。
 *
 * 于是把"内容"与"容器"分开：本组件是内容，`Sidebar` 与 `MobileNavDrawer`
 * 各自提供容器（网格列 / 门户面板）。这样导航结构只有一份实现。
 *
 * ## 账户区为什么是静态的
 *
 * 「我的生活 / 云端账号 / 头像」是原型里的账户区，真实语义属 IAM（Phase 2）。
 * 这里照原型渲染形态但**不接行为**——它不是链接、点击无响应，也就不会
 * 造出一个指向不存在页面的死链，或假装账户体系已经存在。
 */
export function SidebarContent({ onNavigate }: SidebarContentProps) {
  const todayLabel = useTodayLabel();

  // 同 `NavItem` 里的说明：`exactOptionalPropertyTypes` 下不能把 `undefined`
  // 显式传给 `Link` 的 `onClick`，所以按需展开。
  const navProps = onNavigate === undefined ? {} : { onClick: onNavigate };

  return (
    <>
      <Link href="/today" className={styles.brand} {...navProps}>
        {/* 品牌首字取自产品名而不是写死字母：产品改名时这里不会漂移。
            标记本身对读屏无信息量（品牌名就在旁边），所以标记为装饰。 */}
        <span className={styles.brandMark} aria-hidden="true">
          {clientEnv.appName.slice(0, 1)}
        </span>
        <span className={styles.brandName}>{clientEnv.appName}</span>
      </Link>

      <p className={styles.date}>{todayLabel}</p>

      <nav className={styles.list} aria-label="主导航">
        {PRIMARY_NAV_ITEMS.map((item) => (
          <NavItem key={item.href} href={item.href} label={item.label} onClick={onNavigate} />
        ))}
      </nav>

      <div className={styles.bottom}>
        <NavItem
          href={SETTINGS_NAV_ITEM.href}
          label={SETTINGS_NAV_ITEM.label}
          onClick={onNavigate}
        />

        {/* 账户区（IAM / Phase 2 接线）。刻意不是 `<button>`：没有可执行的行为
            就不给交互语义，否则键盘用户会遇到一个"按下去什么也不发生"的控件。 */}
        <div className={styles.profile}>
          <span className={styles.avatar} aria-hidden="true">
            你
          </span>
          <span className={styles.profileText}>
            <strong className={styles.profileName}>我的生活</strong>
            <small className={styles.profileMeta}>云端账号</small>
          </span>
        </div>
      </div>
    </>
  );
}
