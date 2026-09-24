/**
 * 名称截断（SYNC-004，《UI 页面规范》v0.20 §4.9.2 第 2 条）。
 *
 * 用 JS 截断而不是 CSS `text-overflow`：冲突弹层的实体名称要拼进**标题字符串**
 * （`ConfirmDialog` 的 `title` 是 `string`），CSS 在字符串上不起作用。
 * 「查看详情」列表里的名称也走同一个函数，两处的截断口径因此不会漂移。
 *
 * 为什么按**码点**而不是 `String.prototype.slice`：emoji 与部分中文扩展字是
 * 代理对，按 UTF-16 单元截断会把一个字劈成两半，渲染成 。
 */
export function truncateWithEllipsis(value: string, maxCodePoints: number): string {
  const codePoints = [...value];
  if (codePoints.length <= maxCodePoints) {
    return value;
  }
  return `${codePoints.slice(0, maxCodePoints).join('')}…`;
}
