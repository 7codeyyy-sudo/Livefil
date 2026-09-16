/**
 * 日志脱敏（FND-005）。
 *
 * 依据：
 * - 《详细设计说明书》§9 的禁止字段清单：密码、token、API key、完整 AI prompt、
 *   完整任务名称、开销备注、目标理由。
 * - SRS §6.7：不记录密码、令牌、完整 API 密钥；不默认记录完整任务名称、开销备注和心情内容。
 * - SRS NFR-PRIV-007：日志默认使用匿名化 ID，不记录完整开销备注与目标内容。
 *
 * 两条策略刻意分开：
 * - **禁止字段**按名字识别，命中即整体替换为占位符——因为它们的**任何**内容都不能留。
 * - **其余文本**统一做长度截断——「不记录完整内容」用截断表达即可，
 *   而把所有文本都删掉会让日志失去排查价值。
 *
 * 已知边界：字段名匹配采用「归一化后子串包含」，因此 `sessionCount` 这类
 * 含敏感词的正常字段也会被脱敏。这是有意偏向保守——脱敏漏掉的代价远大于多脱一点。
 */

/** 命中即整体替换的字段名片段（已归一化为小写字母数字）。 */
const FORBIDDEN_FIELD_NAME_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'session',
  'credential',
  'privatekey',
];

/** 替换后的占位符。 */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

/** 单个字符串字段的最大长度。 */
export const MAX_TEXT_LENGTH = 200;

/** 递归最大深度。超过即截断，避免循环引用或超深结构拖垮日志。 */
const MAX_DEPTH = 6;

/** 数组最多保留的元素个数。 */
const MAX_ARRAY_ITEMS = 50;

/**
 * 归一化字段名：转小写并去掉分隔符，使 `task_name`、`taskName`、`task-name`
 * 得到同一结果。
 *
 * @param fieldName 原始字段名。
 * @returns 仅含小写字母与数字的字符串。
 */
function normalizeFieldName(fieldName: string): string {
  return fieldName.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

/**
 * 判断字段名是否命中禁止清单。
 *
 * @param fieldName 字段名。
 * @returns 命中时为 true。
 */
export function isForbiddenFieldName(fieldName: string): boolean {
  const normalized = normalizeFieldName(fieldName);
  return FORBIDDEN_FIELD_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * 按长度截断文本。
 *
 * @param value 原始文本。
 * @returns 未超长时原样返回；超长时截断并标注被丢弃的字符数。
 */
function truncateText(value: string): string {
  if (value.length <= MAX_TEXT_LENGTH) {
    return value;
  }
  const dropped = value.length - MAX_TEXT_LENGTH;
  return `${value.slice(0, MAX_TEXT_LENGTH)}…[TRUNCATED ${dropped} chars]`;
}

/**
 * 递归脱敏任意值。
 *
 * @param value 待处理的值。
 * @param fieldName 该值所属的字段名；顶层调用可省略。
 * @param depth 当前递归深度。
 * @returns 可安全写入日志的值。
 */
export function redactValue(value: unknown, fieldName?: string, depth = 0): unknown {
  if (fieldName !== undefined && isForbiddenFieldName(fieldName)) {
    return REDACTED_PLACEHOLDER;
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return truncateText(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    // 错误对象只保留类型名：`message` 可能含 SQL、路径或用户内容（NFR-SEC-007），
    // 而堆栈更是绝不能进入日志。需要细节时请显式放进脱敏后的 context。
    return { name: value.name };
  }

  if (depth >= MAX_DEPTH) {
    return '[TRUNCATED:MAX_DEPTH]';
  }

  if (Array.isArray(value)) {
    const items: unknown[] = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, undefined, depth + 1));

    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[TRUNCATED:${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return items;
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = redactValue(nested, key, depth + 1);
    }
    return result;
  }

  // 函数、symbol 等无法序列化的值：记录类型即可，不尝试序列化。
  return `[UNSERIALIZABLE:${typeof value}]`;
}

/**
 * 脱敏一个上下文字典。
 *
 * @param context 原始上下文。
 * @returns 脱敏后的新对象（原对象不被修改）。
 */
export function redactRecord(
  context: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    result[key] = redactValue(value, key);
  }
  return result;
}
