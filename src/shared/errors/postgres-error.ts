/**
 * PostgreSQL 错误码识别（横切）。
 *
 * ## 为什么必须沿 `cause` 链向上看
 *
 * drizzle-orm 0.45.2 会把驱动抛出的原始 pg 错误**包一层** `DrizzleQueryError`，
 * 真正带 `code`（唯一约束 `23505`、外键冲突 `23503` …）的对象挂在它的 `.cause` 上。
 * 只在顶层读 `error.code` 永远匹配不上——于是「先 INSERT 占位、撞唯一约束再回读既有行」
 * 这类依赖错误码的分支会静默失效：可预期的冲突被当成未知异常，升级成 500。
 *
 * 遍历同时设**深度上限**与 **seen 集合**：包装层数由第三方决定，可能不止一层，
 * 所以不能只看一层；而错误对象允许 `cause` 指向自身或成环，只靠深度上限仍会白跑，
 * seen 集合则保证一旦重复立即退出，杜绝死循环。
 */

/** `cause` 链向上查找的深度上限：包装层数再多也不会接近这个量级。 */
const MAX_CAUSE_DEPTH = 8;

/**
 * 判断错误（含其 `cause` 链上任一层）是否携带指定的 PostgreSQL 错误码。
 *
 * @param error `catch` 到的任意值（可能已被 drizzle 包装）。
 * @param code 目标 PostgreSQL SQLSTATE，如唯一约束 `'23505'`、外键冲突 `'23503'`。
 * @returns 任一层匹配时为 true。
 */
export function hasPostgresErrorCode(error: unknown, code: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let depth = 0;

  while (
    typeof current === 'object' &&
    current !== null &&
    depth < MAX_CAUSE_DEPTH &&
    !seen.has(current)
  ) {
    seen.add(current);
    if ((current as { readonly code?: unknown }).code === code) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
    depth += 1;
  }

  return false;
}
