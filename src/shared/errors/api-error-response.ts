/**
 * API 响应构造（FND-005）。
 *
 * 结构逐字段对齐《接口文档》§1.2（成功）与 §1.4（错误），不增删字段。
 *
 * 刻意返回**纯对象**而不是 `NextResponse`：本模块位于 `src/shared`，
 * 一旦依赖 Next.js 的响应类型，领域测试就被拖上框架、复用也会被绑死。
 * 包装成框架响应是 `app/api/**` 的职责。
 */
import { toAppError } from './app-error.ts';
import type { ErrorCode } from './error-code.ts';

/** 错误响应体，对应《接口文档》§1.4。 */
export interface ApiErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly fields?: Readonly<Record<string, string>>;
    readonly requestId: string;
  };
}

/** 成功响应体，对应《接口文档》§1.2。 */
export interface ApiSuccessBody<TData> {
  readonly data: TData;
  readonly meta: {
    readonly requestId: string;
    /** 服务端时间，UTC ISO 8601。 */
    readonly serverTime: string;
  };
}

/** 状态码与响应体的组合。 */
export interface ApiResult<TBody> {
  readonly status: number;
  readonly body: TBody;
}

/**
 * 校验 requestId 非空。
 *
 * 这里只检查「有没有」，不检查格式：响应构造器不需要知道 requestId 的来源与形态，
 * 格式校验属于生成侧（`src/shared/telemetry/request-id.ts`）。
 * 传空值说明调用方拿错了变量，属于编程错误，应当尽早失败而不是产出一个
 * 无法与日志关联的响应。
 *
 * @param requestId 待校验的值。
 * @throws {TypeError} 为空或纯空白时抛出。
 */
function assertRequestIdPresent(requestId: string): void {
  if (typeof requestId !== 'string' || requestId.trim() === '') {
    throw new TypeError('requestId 必须是非空字符串：它是把客户端错误与日志关联起来的唯一线索');
  }
}

/**
 * 把任意错误转换为 API 错误响应。
 *
 * 非 {@link import('./app-error.ts').AppError} 的错误会被归一化为 `INTERNAL_ERROR`，
 * 且原始 `message` **不会**出现在响应里——第三方错误的文案可能包含 SQL、路径或用户内容
 * （SRS NFR-SEC-007）。原始对象只作为 `cause` 保留在服务端。
 *
 * @param error `catch` 到的任意值。
 * @param requestId 当前请求的 request ID。
 * @returns 状态码与错误响应体。
 * @throws {TypeError} `requestId` 为空时抛出。
 */
export function toErrorResponse(error: unknown, requestId: string): ApiResult<ApiErrorBody> {
  assertRequestIdPresent(requestId);

  const appError = toAppError(error);

  const errorPayload: ApiErrorBody['error'] = {
    code: appError.code,
    message: appError.message,
    requestId,
    // `fields` 只在真正存在时出现：缺省与空对象对客户端的含义不同
    // （「本响应不携带字段级信息」vs「查过了，没有字段级错误」）。
    ...(appError.fields === undefined ? {} : { fields: appError.fields }),
  };

  return Object.freeze({
    status: appError.httpStatus,
    body: Object.freeze({ error: Object.freeze(errorPayload) }),
  });
}

/**
 * 构造成功响应。
 *
 * @param data 业务数据。
 * @param requestId 当前请求的 request ID。
 * @param now 服务端时间；显式传入便于测试固定时间。
 * @param extraMeta 追加到 `meta` 的字段（分页端点的 `nextCursor` / `hasMore`，
 *   见《接口文档》§1.3）。键与既有 meta 冲突时以这里为准——调用方显式给的东西
 *   比"默认必须有"更接近意图。
 * @returns 状态码固定为 200 的响应。
 * @throws {TypeError} `requestId` 为空或 `now` 为无效日期时抛出。
 */
export function toSuccessResponse<TData>(
  data: TData,
  requestId: string,
  now: Date = new Date(),
  extraMeta?: Readonly<Record<string, unknown>>,
): ApiResult<ApiSuccessBody<TData>> {
  assertRequestIdPresent(requestId);

  if (Number.isNaN(now.getTime())) {
    throw new TypeError('now 必须是有效日期');
  }

  return Object.freeze({
    status: 200,
    body: Object.freeze({
      data,
      meta: Object.freeze({
        requestId,
        serverTime: now.toISOString(),
        ...(extraMeta ?? {}),
      }),
    }),
  });
}
