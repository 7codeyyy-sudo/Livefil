import { SidebarContent } from '../SidebarContent';

import styles from './Sidebar.module.css';

/**
 * 桌面/平板的流式侧栏（UI-003）。
 *
 * 只是「把内容放进网格第一列」这一层容器——导航结构在 `SidebarContent`，
 * 与移动端抽屉共用。窄屏下本元素整体隐藏（见样式内的说明）。
 */
export function Sidebar() {
  return (
    <aside className={styles.sidebar} data-app-sidebar="true">
      <SidebarContent />
    </aside>
  );
}
