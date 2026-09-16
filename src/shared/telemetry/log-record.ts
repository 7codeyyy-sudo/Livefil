/**
 * 结构化日志记录（FND-005）。
 *
 * 字段对齐《详细设计说明书》§9 的示例：
 * `timestamp` / `level` / `requestId` / `anonymousUserId` / `route` /
 * `operation` / `errorCode` / `durationMs` / `appVersion`。
 * 另加 `channel` 与 `message`，理由见下方注释。
 *
 * 为什么字段值一律可缺省、且**不允许**中途变成 `undefined`：
 * 日志的价值在于「同一条查询能跨记录聚合」。写入 `{ requestId: undefined }`
 * 与省略 `requestId` 在 JSON 里是两种形态（前者序列化后键消失但类型上仍存在），
 * 会让下游的字段存在性判断失去意义。因此本模块统一约定：**没有值就不要写这个键**。
 */
import type { ErrorCode } from '../errors/error-code.ts';
import type { LogLevel } from './log-level.ts';

/**
 * 日志通道。
 *
 * 分两个通道而非一个：SRS §6.7 要求安全事件日志与普通运行日志的**保留期不同**
 * （90 天 vs 30 天）。把通道建在记录上，将来做留存策略时才有依据可筛，
 * 而不必回头修改所有埋点。
 */
export type LogChannel = 'app' | 'audit';

/** 结构化日志记录。 */
export interface LogRecord {
  /** UTC ISO 8601。 */
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly channel: LogChannel;
  readonly message: string;
  readonly requestId?: string;
  /** **匿名化**的用户标识（哈希），不是用户 ID 本身（SRS NFR-PRIV-007）。 */
  readonly anonymousUserId?: string;
  readonly route?: string;
  readonly operation?: string;
  readonly errorCode?: ErrorCode;
  readonly durationMs?: number;
  /** 版本号。NFR-REL-006 要求错误可关联到版本。 */
  readonly appVersion?: string;
  /** 附加上下文；写入前必经脱敏。 */
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * 调用方可补充的上下文。
 *
 * 已知字段给出类型提示，同时允许补充自定义键——否则每个模块都要发明自己的
 * context 类型，日志的字段名会失去一致性。
 */
export interface LogFields {
  readonly requestId?: string;
  readonly anonymousUserId?: string;
  readonly route?: string;
  readonly operation?: string;
  readonly errorCode?: ErrorCode;
  readonly durationMs?: number;
  readonly appVersion?: string;
}

export type LogContext = LogFields & Readonly<Record<string, unknown>>;
