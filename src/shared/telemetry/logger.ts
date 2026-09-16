/**
 * 结构化日志（FND-005）。
 *
 * 本文件是日志的**唯一入口**。`src/**` 下禁止直接使用 `console`
 * （由 ESLint 保证），原因很直接：一旦有人绕过这里直接打印，
 * 脱敏、requestId 贯穿与字段规范就全部失效，而这些恰恰是日志规范存在的理由。
 *
 * 组成方式沿用项目既有的「接口 + 注入实现」风格（与 `scripts/env/` 一致）：
 * 日志级别、输出目标、时钟、版本全部由调用方注入，因此本模块**没有任何环境依赖**——
 * 不读 `process.env`、不解析文件路径、不触碰项目目录。
 *
 * 文件落盘（`.runtime/logs`）、轮转与保留期**不在本任务范围**：那些需要知道
 * 项目根目录，属于 OPS 阶段。这里只保证「记录是什么形状」，输出到哪里由 sink 决定。
 */
import { isLogLevelEnabled, type LogLevel } from './log-level.ts';
import type { LogChannel, LogContext, LogRecord } from './log-record.ts';
import { redactRecord, redactValue } from './redaction.ts';

/** 输出目标。实现方负责把记录写到某处（控制台、文件、采集器）。 */
export interface LogSink {
  /**
   * 写入一条记录。
   *
   * @param record 已完成脱敏与字段规范化的记录。
   */
  write(record: LogRecord): void;
}

/** 日志接口。 */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /**
   * 派生一个带固定字段的子 logger。
   *
   * 用于把 requestId、route 这类「整个请求期间不变」的字段绑一次，
   * 避免在每个调用点重复传递——重复传递迟早会漏。
   */
  child(bindings: LogContext): Logger;
}

export interface LoggerOptions {
  /** 最低输出级别，默认 `info`。 */
  readonly level?: LogLevel;
  /** 输出目标，默认控制台。 */
  readonly sink?: LogSink;
  /** 时间源，默认系统时钟；注入后可使输出完全确定。 */
  readonly now?: () => Date;
  /** 应用版本，用于把错误关联到发布版本（SRS NFR-REL-006）。 */
  readonly appVersion?: string;
  /** 通道，默认 `app`。 */
  readonly channel?: LogChannel;
  /** 预先绑定的字段。 */
  readonly bindings?: LogContext;
}

/** 调用方未提供版本时的占位值。用显式标记而非空字符串，便于在日志里识别出漏注入。 */
const UNKNOWN_APP_VERSION = 'unknown';

/** 默认最低级别。 */
const DEFAULT_LEVEL: LogLevel = 'info';

/**
 * 创建控制台 sink。
 *
 * 输出 JSON Lines（每行一条完整记录）：重定向到文件后可按行解析，
 * 不需要额外的分隔符约定，也不会因为多行 message 破坏行边界——
 * 换行符在 JSON 里被转义，因此伪造日志行的注入攻击在这里天然失效。
 *
 * @returns 控制台 sink。
 */
export function createConsoleSink(): LogSink {
  return Object.freeze({
    write: (record: LogRecord): void => {
      // eslint-disable-next-line no-console -- sink 的职责就是落到控制台；其余位置一律走 logger
      console.log(JSON.stringify(record));
    },
  });
}

/**
 * 创建 logger。
 *
 * @param options 级别、sink、时钟、版本与预绑定字段。
 * @returns 冻结后的 logger。
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = options.level ?? DEFAULT_LEVEL;
  const sink = options.sink ?? createConsoleSink();
  const now = options.now ?? ((): Date => new Date());
  const appVersion = options.appVersion ?? UNKNOWN_APP_VERSION;
  const channel: LogChannel = options.channel ?? 'app';
  const bindings: LogContext = options.bindings ?? {};

  const write = (level: LogLevel, message: string, context?: LogContext): void => {
    if (!isLogLevelEnabled(level, threshold)) {
      return;
    }

    // 调用点的 context 覆盖 bindings：子 logger 绑定的是默认值，不是硬性约束。
    const merged: LogContext = { ...bindings, ...context };
    const { requestId, anonymousUserId, route, operation, errorCode, durationMs, ...rest } = merged;

    const record: LogRecord = {
      timestamp: now().toISOString(),
      level,
      channel,
      message: redactValue(message) as string,
      appVersion,
      // 逐个条件展开而不是直接赋 undefined：`exactOptionalPropertyTypes` 下
      // 「键存在但值是 undefined」与「键不存在」是两种类型，而日志只需要后者。
      ...(requestId === undefined ? {} : { requestId }),
      ...(anonymousUserId === undefined ? {} : { anonymousUserId }),
      ...(route === undefined ? {} : { route }),
      ...(operation === undefined ? {} : { operation }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(Object.keys(rest).length === 0 ? {} : { context: redactRecord(rest) }),
    };

    sink.write(Object.freeze(record));
  };

  return Object.freeze({
    debug: (message: string, context?: LogContext): void => write('debug', message, context),
    info: (message: string, context?: LogContext): void => write('info', message, context),
    warn: (message: string, context?: LogContext): void => write('warn', message, context),
    error: (message: string, context?: LogContext): void => write('error', message, context),
    child: (childBindings: LogContext): Logger =>
      createLogger({ ...options, bindings: { ...bindings, ...childBindings } }),
  });
}
