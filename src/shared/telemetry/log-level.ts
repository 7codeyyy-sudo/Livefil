/**
 * 日志级别（FND-005）。
 *
 * 级别取值**复用** `src/shared/validation/env.ts` 的 `LOG_LEVELS`，不另立一份：
 * `LOG_LEVEL` 环境变量与日志接口必须使用同一套字面量，否则迟早出现
 * 「环境变量里配得进去、日志接口却不认」的错位，而这类错位只在改配置时才暴露。
 */
import { LOG_LEVELS, type LogLevel } from '../validation/env.ts';

export { LOG_LEVELS };
export type { LogLevel };

/**
 * 级别严重度。
 *
 * 用显式数值而不是数组下标：下标会把「增加一个级别」变成需要重新核对全部顺序的操作，
 * 而数值只要求新级别插入到语义正确的位置。
 */
const SEVERITY_BY_LEVEL: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

/**
 * 判断某级别在给定阈值下是否应当输出。
 *
 * @param level 待判断的级别。
 * @param threshold 当前生效的最低级别。
 * @returns 应当输出时为 true。
 */
export function isLogLevelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return SEVERITY_BY_LEVEL[level] >= SEVERITY_BY_LEVEL[threshold];
}

/**
 * 判断字符串是否为受支持的日志级别。
 *
 * @param value 待判断的值。
 * @returns 是受支持级别时为 true。
 */
export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
