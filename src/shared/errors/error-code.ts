/**
 * API 错误码（FND-005）。
 *
 * **唯一来源**：《接口文档》§1.4 的错误码表，与《详细设计说明书》§6.1 的错误分类一致
 * （两处清单逐项相同）。这是已经确认的对外契约，因此本文件只做映射，
 * **不新增、不改名**——需要新错误码时，必须先改文档再改这里。
 *
 * 为什么码与 HTTP 状态放在同一张表：状态码是码的函数。分开维护迟早会出现
 * 「同一个码在不同地方映射出不同状态」的漂移，而这类漂移在客户端表现为
 * 难以复现的行为差异。
 */

/** 对外错误码。取值与《接口文档》§1.4 的错误码表逐行对应。 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_REPLAY'
  | 'RATE_LIMITED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'DEPENDENCY_TIMEOUT'
  | 'INTERNAL_ERROR';

/**
 * 错误码 → HTTP 状态码。
 *
 * 标注为 `Record<ErrorCode, number>` 而非普通对象：漏写任何一个码都会**编译失败**，
 * 这比运行时断言更早、也更可靠地发现遗漏。
 */
export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ErrorCode, number>> = Object.freeze({
  VALIDATION_ERROR: 400,
  AUTHENTICATION_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_REPLAY: 409,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 502,
  DEPENDENCY_TIMEOUT: 504,
  INTERNAL_ERROR: 500,
});

/**
 * 全部错误码，顺序与文档表格一致。
 *
 * 显式列出而不是 `Object.keys(HTTP_STATUS_BY_ERROR_CODE)`：后者的顺序取决于对象字面量
 * 的书写顺序，一旦有人调整映射表的排列，这里的顺序会跟着变，而它是给文档与验收脚本
 * 对照用的，应当稳定。
 */
export const ERROR_CODES: readonly ErrorCode[] = Object.freeze([
  'VALIDATION_ERROR',
  'AUTHENTICATION_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_REPLAY',
  'RATE_LIMITED',
  'DEPENDENCY_UNAVAILABLE',
  'DEPENDENCY_TIMEOUT',
  'INTERNAL_ERROR',
] satisfies readonly ErrorCode[]);

/**
 * 判断字符串是否为受支持的错误码。
 *
 * @param value 待判定的值。
 * @returns 是受支持错误码时为 true。
 */
export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}
