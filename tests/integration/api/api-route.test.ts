// @vitest-environment node
/**
 * API 路由错误包装器测试（FND-005）。
 *
 * 断言的是**真实的 `Response` 对象**：状态码、响应头、JSON 体，
 * 而不是被包装函数内部的中间结果。原因见 FND-004 的教训——
 * 只在纯函数层验证会让「约束在测试里成立、在运行系统里不成立」。
 *
 * 环境用 node 而非 jsdom：包装器运行在服务端，jsdom 会引入浏览器全局，
 * 反而可能掩盖真实运行时的差异。
 */
import { NextRequest, NextResponse } from 'next/server';
import { describe, expect, it } from 'vitest';

import { createApiRouteHandler } from '../../../app/_lib/api-route.ts';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  DatabaseError,
  DependencyTimeoutError,
  DependencyUnavailableError,
  IdempotencyReplayError,
  InternalError,
  InvariantError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '@/shared/errors/app-error.ts';
import type { LogRecord } from '@/shared/telemetry/log-record.ts';
import { createLogger, type LogSink } from '@/shared/telemetry/logger.ts';
import { REQUEST_ID_HEADER } from '@/shared/telemetry/request-id.ts';

const PROVIDED_REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 收集日志记录的内存 sink。 */
function createRecordingSink(): { readonly records: LogRecord[]; readonly sink: LogSink } {
  const records: LogRecord[] = [];
  return {
    records,
    sink: Object.freeze({
      write: (record: LogRecord): void => {
        records.push(record);
      },
    }),
  };
}

/**
 * 构造一个进入包装器的请求。
 *
 * @param headers 附加请求头。
 * @returns NextRequest 实例。
 */
function createRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/v1/probe', { headers });
}

/**
 * 构造一个总是抛出指定错误的处理器。
 *
 * @param error 抛出的值。
 * @returns 包装后的处理器。
 */
function handlerThrowing(error: unknown) {
  const { records, sink } = createRecordingSink();
  const handler = createApiRouteHandler(
    (): never => {
      throw error;
    },
    { operation: 'probe', logger: createLogger({ sink, level: 'debug' }) },
  );
  return { handler, records };
}

/** 错误类 → 期望的 HTTP 状态。与《接口文档》§1.4 的错误码表对应。 */
const ERROR_CASES = [
  {
    label: '校验错误',
    error: new ValidationError('输入不合法'),
    status: 400,
    code: 'VALIDATION_ERROR',
  },
  {
    label: '未认证',
    error: new AuthenticationError('未登录'),
    status: 401,
    code: 'AUTHENTICATION_REQUIRED',
  },
  { label: '无权访问', error: new AuthorizationError('无权'), status: 403, code: 'FORBIDDEN' },
  { label: '不存在', error: new NotFoundError('不存在'), status: 404, code: 'NOT_FOUND' },
  { label: '版本冲突', error: new ConflictError('冲突'), status: 409, code: 'CONFLICT' },
  {
    label: '重复提交',
    error: new IdempotencyReplayError('已处理'),
    status: 409,
    code: 'IDEMPOTENCY_REPLAY',
  },
  { label: '限流', error: new RateLimitError('超限'), status: 429, code: 'RATE_LIMITED' },
  {
    label: '依赖不可用',
    error: new DependencyUnavailableError('外部服务不可用'),
    status: 502,
    code: 'DEPENDENCY_UNAVAILABLE',
  },
  {
    label: '依赖超时',
    error: new DependencyTimeoutError('外部服务超时'),
    status: 504,
    code: 'DEPENDENCY_TIMEOUT',
  },
  { label: '内部错误', error: new InternalError(), status: 500, code: 'INTERNAL_ERROR' },
] as const;

describe('失败路径：10 类错误逐一转换为真实响应', () => {
  it.each(ERROR_CASES)('$label → HTTP $status / $code', async ({ error, status, code }) => {
    const { handler } = handlerThrowing(error);
    const response = await handler(
      createRequest({ [REQUEST_ID_HEADER]: PROVIDED_REQUEST_ID }),
      undefined,
    );

    expect(response.status).toBe(status);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(PROVIDED_REQUEST_ID);

    const body = await response.json();
    expect(body.error.code).toBe(code);
    expect(body.error.requestId).toBe(PROVIDED_REQUEST_ID);
  });

  it('校验错误的 fields 会出现在响应里', async () => {
    const { handler } = handlerThrowing(
      new ValidationError('任务标题不能为空', { fields: { title: 'required' } }),
    );

    const body = await (await handler(createRequest(), undefined)).json();

    expect(body.error.fields).toEqual({ title: 'required' });
  });
});

describe('失败路径：内部错误的兜底', () => {
  it('未知错误归一化为 INTERNAL_ERROR，不泄露原始信息', async () => {
    const { handler } = handlerThrowing(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 select * from users'),
    );
    const response = await handler(createRequest(), undefined);
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    for (const leaked of ['ECONNREFUSED', '10.0.0.5', 'select * from users']) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('DatabaseError 对外是 INTERNAL_ERROR，内部细节只进日志', async () => {
    const { handler, records } = handlerThrowing(
      new DatabaseError({ details: { sql: 'select * from users', table: 'users' } }),
    );
    const response = await handler(createRequest(), undefined);

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('select * from users');

    // 日志里保留线索，便于排查。
    expect(JSON.stringify(records)).toContain('select * from users');
  });

  it('InvariantError 同样是 INTERNAL_ERROR', async () => {
    const { handler } = handlerThrowing(new InvariantError({ message: '状态机进入未知状态' }));
    expect((await handler(createRequest(), undefined)).status).toBe(500);
  });
});

describe('requestId 在包装器内的行为', () => {
  it('请求头缺失时生成合法 UUID 并回写', async () => {
    const { handler } = handlerThrowing(new NotFoundError('x'));
    const response = await handler(createRequest(), undefined);

    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(UUID_V4);
  });

  it('非法请求头被丢弃，生成新的合法值', async () => {
    const { handler } = handlerThrowing(new NotFoundError('x'));
    const response = await handler(createRequest({ [REQUEST_ID_HEADER]: 'req_123' }), undefined);
    const value = response.headers.get(REQUEST_ID_HEADER);

    expect(value).not.toBe('req_123');
    expect(value).toMatch(UUID_V4);
  });

  it('成功响应同样回写 requestId', async () => {
    const handler = createApiRouteHandler((): NextResponse => NextResponse.json({ ok: true }), {
      operation: 'probe',
    });
    const response = await handler(
      createRequest({ [REQUEST_ID_HEADER]: PROVIDED_REQUEST_ID }),
      undefined,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(PROVIDED_REQUEST_ID);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('包装器不依赖代理层：进程内直接调用也能得到正确的头', async () => {
    // 这是刻意设计：包装器自己解析一次，因此脱离代理层（测试、服务端内部调用）
    // 仍能保证响应头存在。
    const handler = createApiRouteHandler((): NextResponse => NextResponse.json({}), {});
    const response = await handler(
      createRequest({ [REQUEST_ID_HEADER]: PROVIDED_REQUEST_ID }),
      undefined,
    );

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(PROVIDED_REQUEST_ID);
  });
});

describe('失败时的日志', () => {
  it('写入一条 error 级脱敏日志，含 requestId 与错误码', async () => {
    const { handler, records } = handlerThrowing(new ValidationError('输入不合法'));

    await handler(createRequest({ [REQUEST_ID_HEADER]: PROVIDED_REQUEST_ID }), undefined);

    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.level).toBe('error');
    expect(record?.requestId).toBe(PROVIDED_REQUEST_ID);
    expect(record?.errorCode).toBe('VALIDATION_ERROR');
    expect(record?.operation).toBe('probe');
    expect(typeof record?.durationMs).toBe('number');
  });

  it('日志中的敏感字段被脱敏', async () => {
    const { handler, records } = handlerThrowing(
      new ValidationError('x', { details: { password: 'hunter2', authorization: 'Bearer abc' } }),
    );

    await handler(createRequest(), undefined);

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('Bearer abc');
  });

  it('成功路径不写日志（本任务不接全量访问日志）', async () => {
    const { records, sink } = createRecordingSink();
    const handler = createApiRouteHandler((): NextResponse => NextResponse.json({}), {
      logger: createLogger({ sink, level: 'debug' }),
    });

    await handler(createRequest(), undefined);

    expect(records).toHaveLength(0);
  });
});
