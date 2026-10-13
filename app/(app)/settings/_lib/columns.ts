/**
 * 设置页七栏清单（PM-20261012-008 提案 A / UI v0.31 候审 2.1 栏结构表）。
 *
 * ## 为什么单独成文件
 *
 * 同一组「栏」要在四个地方渲染：桌面 rail、移动端栏列表、`/settings` 的
 * 首栏重定向、以及各栏页面的标题。四份清单写在各自的组件里必然漂移——
 * 这与外壳导航项清单收进 `nav-items.ts`（UI-003）是同一条纪律。
 *
 * ## 编号口径
 *
 * 现「分区 1–9」是《UI 页面规范》§5 的历史编号（冻结文本，保留不动）；
 * 本文件的 7 栏是 v0.31 补节声明的**新容器结构**，两者是映射关系而非替代。
 * 栏顺序＝提案 2.1 表序（高频在前），不随分区编号。
 */
import type { UserDto } from '@/modules/identity/application/user-dto.ts';

/** 栏标识（路由段）。 */
export type SettingsColumnId =
  'account' | 'appearance' | 'notifications' | 'ai-privacy' | 'data' | 'life-areas' | 'general';

export type SettingsColumnDefinition = {
  readonly id: SettingsColumnId;
  /** 栏名（rail、栏列表与页面标题共用）。 */
  readonly name: string;
  /** 独立 URL（直达可分享、刷新不丢）。 */
  readonly href: string;
  /**
   * 仅认证部署态渲染。
   *
   * 分区 9（账号）按规范 §5 第 9 条「仅认证部署态渲染」——本地自用态没有
   * 账号概念（C4），该栏在 local 模式下不存在：rail 不出现、栏列表不出现、
   * 直达 URL 则重定向到其后的首栏。
   */
  readonly cloudOnly?: true;
};

/** 七栏清单（顺序即提案 2.1 表序）。 */
export const SETTINGS_COLUMNS: readonly SettingsColumnDefinition[] = [
  { id: 'account', name: '账号', href: '/settings/account', cloudOnly: true },
  { id: 'appearance', name: '外观', href: '/settings/appearance' },
  { id: 'notifications', name: '提醒与通知', href: '/settings/notifications' },
  { id: 'ai-privacy', name: 'AI 与隐私', href: '/settings/ai-privacy' },
  { id: 'data', name: '数据管理', href: '/settings/data' },
  { id: 'life-areas', name: '生活领域', href: '/settings/life-areas' },
  { id: 'general', name: '通用', href: '/settings/general' },
];

/** 按部署形态取可见栏（local 态过滤掉仅认证栏）。 */
export function visibleColumns(mode: UserDto['mode']): readonly SettingsColumnDefinition[] {
  return SETTINGS_COLUMNS.filter((column) => column.cloudOnly !== true || mode === 'cloud');
}

/** 可见栏的首栏：进入设置的落点（提案 2.2.5——侧栏「设置」点击进首栏）。 */
export function firstVisibleColumn(mode: UserDto['mode']): SettingsColumnDefinition {
  const columns = visibleColumns(mode);
  const head = columns[0];
  // 七栏恒非空（过滤最多去掉 account 一栏），这里只是把「不可能」写成显式失败，
  // 免得将来有人把 cloudOnly 加到所有栏上时得到一个 undefined 调用崩溃。
  if (head === undefined) {
    throw new Error('设置栏清单为空：cloudOnly 过滤条件可能写错了');
  }
  return head;
}

/** 按 id 取栏定义（各栏页面用它取栏名与 URL，避免标题与清单两处漂移）。 */
export function columnById(id: SettingsColumnId): SettingsColumnDefinition {
  const column = SETTINGS_COLUMNS.find((candidate) => candidate.id === id);
  if (column === undefined) {
    throw new Error(`未知的设置栏 id：${id}`);
  }
  return column;
}
