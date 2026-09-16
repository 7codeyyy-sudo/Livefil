/**
 * 应用错误类型体系（FND-005）。
 *
 * 分两类子类，区别是刻意的：
 *
 * 1. **契约错误**（`ValidationError` 等 10 个）与《接口文档》§1.4 的错误码**一一对应**，
 *    其 `code` 就是对外响应里的 `error.code`。这类错误的信息可以安全地展示给用户。
 *
 * 2. **内部错误**（`DatabaseError`、`InvariantError`）继承 `InternalError`，
 *    对外一律呈现为 `INTERNAL_ERROR`。它们携带的细节——SQL、表名、连接串、原始堆栈——
 *    只允许出现在**脱敏日志**里，绝不能进入 API 响应（SRS NFR-SEC-007）。
 *
 * 为什么每个码一个类而不是「一个类 + 码枚举」：`instanceof` 是最廉价、最不容易写错的
 * 捕获手段。用枚举做条件判断时，漏掉一个分支不会有任何编译期提示。
 */
import { HTTP_STATUS_BY_ERROR_CODE, type ErrorCode } from './error-code.ts';

/** 构造应用错误时的可选信息。 */
export interface AppErrorOptions {
  /**
   * 字段级错误，用于表单校验反馈。键为字段名，值为原因。
   *
   * 会进入 API 响应的 `error.fields`，因此**只能放面向用户的安全内容**。
   */
  readonly fields?: Readonly<Record<string, string>>;
  /**
   * 原始错误，作为 `cause` 保留。
   *
   * 仅供**服务端日志**追溯，不进入 API 响应。
   */
  readonly cause?: unknown;
  /**
   * 内部线索（实体 ID、操作名、受影响记录数等）。
   *
   * 仅供**服务端日志**使用，不进入 API 响应。
   */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * 应用错误基类。
 *
 * 声明为 `abstract` 且构造函数为 `protected`：外部只能抛出具体的语义错误，
 * 不能抛出「没有语义的 AppError」——那会让捕获方无从判断该如何处理。
 */
export abstract class AppError extends Error {
  /** 对外错误码。内部错误类也有值，因为它决定对外呈现。 */
  readonly code: ErrorCode;
  /** HTTP 状态码，由 `code` 唯一决定，不单独传入以避免不一致。 */
  readonly httpStatus: number;
  /** 字段级错误；仅对校验类错误有意义。 */
  readonly fields: Readonly<Record<string, string>> | undefined;
  /** 内部线索，只进日志。 */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  protected constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    // 用 new.target 取名，子类无需重复写 this.name。
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_ERROR_CODE[code];
    this.fields = options.fields;
    this.details = options.details;
  }
}

/** 输入不合法（400）。用 `fields` 指出具体是哪些字段有问题。 */
export class ValidationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('VALIDATION_ERROR', message, options);
  }
}

/** 未登录或令牌失效（401）。 */
export class AuthenticationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('AUTHENTICATION_REQUIRED', message, options);
  }
}

/** 已登录但无权访问（403）。 */
export class AuthorizationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('FORBIDDEN', message, options);
  }
}

/**
 * 资源不存在**或不属于当前用户**（404）。
 *
 * 两种情形共用 404 是刻意的：对无权访问的资源返回 403 会泄露「该资源存在」这一信息。
 */
export class NotFoundError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('NOT_FOUND', message, options);
  }
}

/** 版本冲突（409）。 */
export class ConflictError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('CONFLICT', message, options);
  }
}

/**
 * 重复请求已处理（409）。
 *
 * 用于 `Idempotency-Key` 命中既有结果时——它不是错误，而是「同一次操作被重放了」，
 * 因此调用方应当把先前的结果返回给客户端，而不是提示失败。
 */
export class IdempotencyReplayError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('IDEMPOTENCY_REPLAY', message, options);
  }
}

/** 超过限流或 AI 配额（429）。 */
export class RateLimitError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('RATE_LIMITED', message, options);
  }
}

/** 外部服务不可用（502）。 */
export class DependencyUnavailableError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('DEPENDENCY_UNAVAILABLE', message, options);
  }
}

/** 外部服务超时（504）。与「不可用」分开，因为两者的重试策略不同。 */
export class DependencyTimeoutError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('DEPENDENCY_TIMEOUT', message, options);
  }
}

/** 未预期错误的对外默认文案。刻意笼统：它会被原样返回给客户端。 */
const INTERNAL_ERROR_MESSAGE = '服务内部错误，请稍后重试并提供请求编号';

/** 数据库错误的对外文案。同样不暴露任何结构信息。 */
const DATABASE_ERROR_MESSAGE = '数据访问失败，请稍后重试';

/** 构造内部错误时可覆盖默认文案。 */
export interface InternalErrorOptions extends AppErrorOptions {
  /** 覆盖默认文案。**不得**放入 SQL、表名、连接串或堆栈。 */
  readonly message?: string;
}

/** 未预期的内部错误（500）。 */
export class InternalError extends AppError {
  constructor(options: InternalErrorOptions = {}) {
    super('INTERNAL_ERROR', options.message ?? INTERNAL_ERROR_MESSAGE, options);
  }
}

/**
 * 数据库访问失败。
 *
 * 对外与 `InternalError` 无法区分（同为 `INTERNAL_ERROR`），区别只在服务端：
 * 捕获方可以据此决定「可重试」还是「应告警」，日志也可以额外标注。
 * 原始异常请放进 `cause`，它不会进入响应。
 */
export class DatabaseError extends InternalError {
  constructor(options: AppErrorOptions = {}) {
    super({ ...options, message: DATABASE_ERROR_MESSAGE });
  }
}

/**
 * 领域不变量被破坏。
 *
 * 它意味着「代码走到了本不该到达的状态」，属于缺陷而非用户输入问题，
 * 因此对外同样是 `INTERNAL_ERROR`，但日志侧应当被当作需要修复的信号。
 */
export class InvariantError extends InternalError {
  constructor(options: InternalErrorOptions = {}) {
    super(options);
  }
}

/**
 * 把任意抛出物归一化为 {@link AppError}。
 *
 * 非 `AppError` 一律视为 `InternalError`：第三方的原始 `message` 可能包含 SQL、文件路径
 * 或用户内容，直接透出等于把内部结构泄露给调用方。原始对象作为 `cause` 保留，
 * 只在服务端日志里可见。
 *
 * @param error 捕获到的任意值（`catch` 的参数类型是 `unknown`）。
 * @returns 可安全转换的 `AppError`；若入参已是 `AppError` 则原样返回。
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  return new InternalError({ cause: error });
}
