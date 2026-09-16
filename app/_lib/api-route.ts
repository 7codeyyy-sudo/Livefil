/**
 * API 路由错误处理包装器（FND-005）。
 *
 * 职责只有一件事：把「抛出的错误」变成「符合《接口文档》§1.4 的响应」，
 * 并在服务端留下一条脱敏日志。业务逻辑一律由被包装的处理器负责。
 *
 * 为什么放在 `app/_lib/` 而不是 `src/shared/`：本文件依赖 `next/server`。
 * `src/shared/errors/api-error-response.ts` 的注释早已写明「包装成框架响应是
 * `app/api` 的职责」——保持 shared 层的框架中立，是让领域测试不被拖上框架的前提。
 * `_lib` 前缀是 App Router 的私有目录约定，不会被当成路由。
 *
 * 为什么用包装器而不是在代理层（proxy）统一兜底：代理层运行在路由匹配之前，
 * 拿不到路由处理器抛出的错误，也无法为不同端点区分语义（校验失败与内部错误
 * 的差别只有处理器自己知道）。包装器是唯一能同时拿到「错误语义」与「请求上下文」的位置。
 */
import { NextResponse, type NextRequest } from 'next/server';

import { toAppError } from '@/shared/errors/app-error.ts';
import { toErrorResponse } from '@/shared/errors/api-error-response.ts';
import { createLogger, type Logger } from '@/shared/telemetry/logger.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/shared/telemetry/request-id.ts';

/**
 * 被包装的业务处理器。
 *
 * `TContext` 由调用方决定：App Router 的路由处理器第二个参数形状不同
 * （静态路由无参数、动态路由带 `params`），用泛型透传比在这里假装知道更好。
 */
export type ApiRouteHandler<TContext> = (
  request: NextRequest,
  context: TContext,
) => Promise<NextResponse> | NextResponse;

export interface ApiRouteOptions {
  /** 操作名，用于日志聚合。缺省时不写该字段。 */
  readonly operation?: string;
  /**
   * 日志器。缺省时创建控制台 logger。
   *
   * 允许注入是为了让测试能够断言「失败时确实写了一条脱敏日志」，
   * 而不必去捕获控制台输出。
   */
  readonly logger?: Logger;
}

/**
 * 包装一个 API 路由处理器。
 *
 * 成功路径：原样返回处理器的响应，仅补上 `x-request-id` 响应头。
 * 失败路径：把错误归一化为 `AppError`，转换为 §1.4 的结构，并记录一条脱敏错误日志。
 *
 * @param handler 业务处理器。
 * @param options 操作名与日志器。
 * @returns 具有同样签名的包装后处理器。
 */
export function createApiRouteHandler<TContext>(
  handler: ApiRouteHandler<TContext>,
  options: ApiRouteOptions = {},
): ApiRouteHandler<TContext> {
  const logger = options.logger ?? createLogger();

  return async (request: NextRequest, context: TContext): Promise<NextResponse> => {
    // 代理层通常已解析过；这里再解析一次是为了让包装器**不依赖代理层存在**
    // ——进程内直接调用（测试、或将来的服务端调用）同样能得到正确的头。
    // 合法值会被代理层透传下来，因此两次解析结果一致。
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const startedAt = Date.now();

    try {
      const response = await handler(request, context);
      response.headers.set(REQUEST_ID_HEADER, requestId);
      return response;
    } catch (error) {
      const appError = toAppError(error);
      const { status, body } = toErrorResponse(appError, requestId);

      logger.error('API 请求失败', {
        requestId,
        route: new URL(request.url).pathname,
        errorCode: appError.code,
        errorMessage: appError.message,
        durationMs: Date.now() - startedAt,
        ...(options.operation === undefined ? {} : { operation: options.operation }),
        // 内部线索只进日志；它们不会出现在上面的响应体里。
        ...(appError.details === undefined ? {} : { errorDetails: appError.details }),
      });

      return NextResponse.json(body, {
        status,
        headers: { [REQUEST_ID_HEADER]: requestId },
      });
    }
  };
}
