/**
 * 外壳导航项的**单一来源**（UI-003）。
 *
 * ## 为什么单独成文件
 *
 * 同一组导航要在两个地方渲染：桌面/平板的流式侧栏，和移动端抽屉。
 * 两份清单写在各自的组件里必然漂移——加了第六项却只改一处，是这个
 * 规模的项目里最容易发生、也最难在测试里发现的错误（导航项数量不会
 * 在任何断言里自然对不上）。所以清单只定义一次，两个消费者都读它。
 *
 * ## 为什么分成两组
 *
 * 原型把主导航与「设置」分开摆：前五项是业务入口（侧栏中部），
 * 设置与账户区一起落在侧栏底部（`margin-top: auto` 顶下去）。
 * 这个分组是**布局意图**，不只是顺序，所以保留成交互上的两组。
 */

export type NavItemDefinition = {
  /** 目标路由。与 §3.2 冻结的目录一致。 */
  readonly href: string;
  /** 导航文字。折叠档下 `::first-letter` 取它的首字（今/收/目/开/复/设）。 */
  readonly label: string;
};

/** 主导航五项：侧栏中部与移动端抽屉中部共用。 */
export const PRIMARY_NAV_ITEMS = [
  { href: '/today', label: '今日' },
  { href: '/inbox', label: '收件箱' },
  { href: '/goals', label: '目标' },
  { href: '/expenses', label: '开销' },
  { href: '/review', label: '复盘' },
] as const satisfies readonly NavItemDefinition[];

/** 「设置」单列一项，落在侧栏/抽屉底部。 */
export const SETTINGS_NAV_ITEM = {
  href: '/settings',
  label: '设置',
} as const satisfies NavItemDefinition;

/** 六个导航项的完整清单（顺序即 §3.2 冻结的目录顺序）。 */
export const NAV_ITEMS: readonly NavItemDefinition[] = [...PRIMARY_NAV_ITEMS, SETTINGS_NAV_ITEM];
