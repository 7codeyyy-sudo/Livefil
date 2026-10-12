/**
 * 「帮助与引导」抽屉的内容映射（《UI 页面规范》v0.22 §5 B，AI-002）。
 *
 * 「当前页下一步」是按路由的**静态映射**：这张表就是它唯一的准据，文案逐字取自
 * §5 B 的冻结表，不许改写、不许加标点。
 *
 * 表里没列的路由（如 `/week`、`/goals/{goalId}`）走中性兜底——§5 B 只冻结了那
 * 六条，为没冻结的页面**自拟一句"下一步"就是在编规则**，兜底只陈述"这里没有额外
 * 提示"，不假装知道用户该干什么。
 */

/** 路由 → 「当前页下一步」文案（§5 B 冻结六条）。 */
const HELP_NEXT_STEP_BY_ROUTE: Readonly<Record<string, string>> = {
  '/today': '把今天的任务排进时间线。',
  '/inbox': '快速记下一件事，稍后再整理。',
  '/goals': '创建目标，并写下第一个行动。',
  '/expenses': '记下第一笔开销。',
  '/review': '回答三问中的任意一题，完成今天的复盘。',
  '/settings': '按需调整提醒、语言与 AI 偏好。',
};

/** 未冻结路由的中性兜底（见文件说明）。 */
const FALLBACK_NEXT_STEP = '这一页没有额外的下一步提示，可以从顶栏去别的页面继续。';

/**
 * 取当前路由的「下一步」文案。
 *
 * @param pathname `usePathname()` 的返回值（不含查询串与 hash，与表里的键同形）。
 */
export function helpNextStepText(pathname: string): string {
  const exact = HELP_NEXT_STEP_BY_ROUTE[pathname];
  if (exact !== undefined) {
    return exact;
  }
  // 设置页两栏化（PM-20261012-008）后当前路由是 `/settings/<栏>`：帮助讲的
  // 是「设置这一页」的下一步，与落在哪一栏无关，沿用 `/settings` 条目。
  // 冻结表本身一字未动——这里只是查找口径对子路由的自然延伸。
  for (const [route, text] of Object.entries(HELP_NEXT_STEP_BY_ROUTE)) {
    if (pathname.startsWith(`${route}/`)) {
      return text;
    }
  }
  return FALLBACK_NEXT_STEP;
}
