/**
 * 审计与安全事件（FND-005）。
 *
 * 依据 SRS §6.7「权限和审计日志」：
 *
 * > 第一阶段至少记录以下事件的时间、结果、匿名用户标识和版本：
 * > 登录成功/失败；创建、修改、删除和恢复数据；导出和导入数据；
 * > AI 调用开始、成功、失败、超时和额度耗尽；权限错误和异常请求；数据同步冲突。
 *
 * 事件枚举**严格按这 6 类展开**，不额外发明类目。多出来的名字会让「SRS 要求记录什么」
 * 变得不可核对——需要新类目时应当先改 SRS。
 *
 * 为什么现在就立这条通道，而不是等埋点时再说：SRS 要求安全事件与普通运行日志的
 * **保留期不同**（90 天 vs 30 天）。如果通道不是记录本身的属性，
 * 将来实现留存策略时就得回头修改所有埋点，而漏掉的那几处不会有任何提示。
 *
 * 本任务只交付接口与字段。留存、归档与导出属 OPS 阶段。
 */
import type { ErrorCode } from '../errors/error-code.ts';
import type { Logger, LoggerOptions } from './logger.ts';
import { createLogger } from './logger.ts';

/** SRS §6.7 的 6 类事件。 */
export type AuditEventCategory =
  | 'authentication'
  | 'data-mutation'
  | 'data-portability'
  | 'ai-invocation'
  | 'access-control'
  | 'sync';

/** 具体事件类型。 */
export type AuditEventType =
  // 登录成功/失败
  | 'AUTH_LOGIN_SUCCEEDED'
  | 'AUTH_LOGIN_FAILED'
  // 创建、修改、删除和恢复数据
  | 'DATA_CREATED'
  | 'DATA_UPDATED'
  | 'DATA_DELETED'
  | 'DATA_RESTORED'
  // 导出和导入数据
  | 'DATA_EXPORTED'
  | 'DATA_IMPORTED'
  // AI 调用开始、成功、失败、超时和额度耗尽
  | 'AI_INVOCATION_STARTED'
  | 'AI_INVOCATION_SUCCEEDED'
  | 'AI_INVOCATION_FAILED'
  | 'AI_INVOCATION_TIMED_OUT'
  | 'AI_QUOTA_EXHAUSTED'
  // 权限错误和异常请求
  | 'PERMISSION_DENIED'
  | 'ABNORMAL_REQUEST'
  // 数据同步冲突
  | 'SYNC_CONFLICT_DETECTED';

/**
 * 事件类型 → 所属类目。
 *
 * 标注为 `Record<AuditEventType, AuditEventCategory>`：新增事件类型时若忘记归类，
 * 编译就会失败。类目是留存与审计查询的依据，漏归类等于事件无从筛选。
 */
export const AUDIT_CATEGORY_BY_EVENT_TYPE: Readonly<Record<AuditEventType, AuditEventCategory>> =
  Object.freeze({
    AUTH_LOGIN_SUCCEEDED: 'authentication',
    AUTH_LOGIN_FAILED: 'authentication',
    DATA_CREATED: 'data-mutation',
    DATA_UPDATED: 'data-mutation',
    DATA_DELETED: 'data-mutation',
    DATA_RESTORED: 'data-mutation',
    DATA_EXPORTED: 'data-portability',
    DATA_IMPORTED: 'data-portability',
    AI_INVOCATION_STARTED: 'ai-invocation',
    AI_INVOCATION_SUCCEEDED: 'ai-invocation',
    AI_INVOCATION_FAILED: 'ai-invocation',
    AI_INVOCATION_TIMED_OUT: 'ai-invocation',
    AI_QUOTA_EXHAUSTED: 'ai-invocation',
    PERMISSION_DENIED: 'access-control',
    ABNORMAL_REQUEST: 'access-control',
    SYNC_CONFLICT_DETECTED: 'sync',
  });

/** 事件结果。 */
export type AuditOutcome = 'succeeded' | 'failed';

/** 已落定的审计事件。 */
export interface AuditEvent {
  readonly type: AuditEventType;
  readonly category: AuditEventCategory;
  readonly outcome: AuditOutcome;
  /** UTC ISO 8601。 */
  readonly occurredAt: string;
  /** 匿名化用户标识；未登录场景（如登录失败）为 null。 */
  readonly anonymousUserId: string | null;
  readonly appVersion: string;
  readonly requestId?: string;
  readonly errorCode?: ErrorCode;
}

/**
 * 待记录的审计事件。
 *
 * `category`、`occurredAt`、`appVersion` 由审计器补齐：让调用点填写这些字段，
 * 等于要求每个埋点都正确重复同一份信息，而其中任何一处填错都不会被发现。
 */
export interface AuditEventInput {
  readonly type: AuditEventType;
  readonly outcome: AuditOutcome;
  readonly anonymousUserId: string | null;
  readonly requestId?: string;
  readonly errorCode?: ErrorCode;
}

/** 审计日志接口。 */
export interface AuditLogger {
  /**
   * 记录一条审计事件。
   *
   * @param event 事件内容。
   */
  record(event: AuditEventInput): void;
}

/** 构造审计器的选项。通道固定为 `audit`，因此不允许传入。 */
export interface AuditLoggerOptions extends Omit<LoggerOptions, 'channel'> {
  /** 应用版本。SRS §6.7 要求审计事件带版本。 */
  readonly appVersion: string;
}

/**
 * 创建审计器。
 *
 * @param options 版本、输出目标、级别与时钟。
 * @returns 冻结后的审计器。
 */
export function createAuditLogger(options: AuditLoggerOptions): AuditLogger {
  const { appVersion, ...loggerOptions } = options;
  const logger: Logger = createLogger({ ...loggerOptions, channel: 'audit', appVersion });

  // 与 logger 共用同一个时钟：审计事件与它对应的运行日志必须落在同一时间基准上，
  // 各自取系统时间会在测试里产生无法对齐的时间戳。
  const now = loggerOptions.now ?? ((): Date => new Date());

  return Object.freeze({
    record: (event: AuditEventInput): void => {
      const record: AuditEvent = {
        type: event.type,
        category: AUDIT_CATEGORY_BY_EVENT_TYPE[event.type],
        outcome: event.outcome,
        occurredAt: now().toISOString(),
        anonymousUserId: event.anonymousUserId,
        appVersion,
        ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
      };

      // 审计事件经统一 logger 写出，因此同样受脱敏与字段规范约束。
      // `auditEvent` 作为结构化上下文传入，而不是拼进 message——
      // 拼字符串会让字段无法被查询与聚合。
      logger.info(`审计事件：${event.type}`, { auditEvent: record });
    },
  });
}
