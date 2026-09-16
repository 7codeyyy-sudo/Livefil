/**
 * 请求 ID（FND-005）。
 *
 * 契约见《接口文档》：
 * - §1.1 请求头 `X-Request-Id: <client-request-id>`
 * - §1.2 成功响应 `meta.requestId`
 * - §1.4 错误响应 `error.requestId`
 *
 * 格式为 **UUID v4**，不加前缀。文档示例里的 `req_123` 只是占位展示，不是格式约定；
 * 字段表（《详细设计说明书》§9）写的是 `uuid`，且 UUID 在日志检索、数据库列类型
 * 与 OpenTelemetry 兼容性上都更省事。
 */
import { randomUUID } from 'node:crypto';

/** 请求头名，小写形式（HTTP 头名大小写不敏感）。 */
export const REQUEST_ID_HEADER = 'x-request-id';

/** UUID v4 的形态。 */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 生成新的请求 ID。
 *
 * @returns UUID v4 字符串。
 */
export function createRequestId(): string {
  return randomUUID();
}

/**
 * 判断值是否为合法请求 ID。
 *
 * @param value 待判定的值。
 * @returns 形如 UUID v4 时为 true。
 */
export function isValidRequestId(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

/**
 * 解析客户端传入的请求 ID，缺失或非法时生成新的。
 *
 * 对非法值**不报错而重新生成**，是刻意的：请求头来自不可信来源，把它当作
 * 需要拒绝的输入会让任意客户端都能用一个畸形头让接口失败。
 * 同时，正则天然拒绝含换行、控制字符或超长的值——这类值若被回写进响应头或日志，
 * 就是一次头注入/日志注入。
 *
 * @param headerValue 请求头原始值；可能为 `null`（头不存在）。
 * @returns 合法的请求 ID。
 */
export function resolveRequestId(headerValue: string | null | undefined): string {
  if (typeof headerValue === 'string') {
    const candidate = headerValue.trim();
    if (isValidRequestId(candidate)) {
      return candidate;
    }
  }
  return createRequestId();
}
