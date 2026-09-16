/**
 * API 响应构造测试（FND-005）。
 *
 * 断言方式刻意用**整体结构相等**而不是逐个字段检查：
 * 接口文档 §1.2/§1.4 定义的是一个精确的对象形状，
 * 逐字段检查无法发现「多了一个字段」——而多出来的字段同样是契约漂移。
 */
import { describe, expect, it } from 'vitest';

import { InternalError, NotFoundError, ValidationError } from '@/shared/errors/app-error.ts';
import { toErrorResponse, toSuccessResponse } from '@/shared/errors/api-error-response.ts';

/** 一个形态合法的 UUID v4，用作 requestId。 */
const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';

/** 固定时间，避免断言依赖真实时钟。 */
const FIXED_NOW = new Date('2026-09-16T04:00:00.000Z');

describe('toErrorResponse 与《接口文档》§1.4 一致', () => {
  it('校验错误带 fields 时结构与文档示例完全一致', () => {
    const result = toErrorResponse(
      new ValidationError('任务标题不能为空', { fields: { title: 'required' } }),
      REQUEST_ID,
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: '任务标题不能为空',
        fields: { title: 'required' },
        requestId: REQUEST_ID,
      },
    });
  });

  it('无 fields 时不出现 fields 键', () => {
    const result = toErrorResponse(new NotFoundError('资源不存在'), REQUEST_ID);

    expect(result.body.error).toEqual({
      code: 'NOT_FOUND',
      message: '资源不存在',
      requestId: REQUEST_ID,
    });
    expect(Object.keys(result.body.error).sort()).toEqual(['code', 'message', 'requestId']);
  });

  it('空 fields 对象会被保留（与缺省含义不同）', () => {
    const result = toErrorResponse(new ValidationError('x', { fields: {} }), REQUEST_ID);

    expect(result.body.error.fields).toEqual({});
  });

  it('requestId 出现在错误体内，与日志中的值相同', () => {
    const result = toErrorResponse(new NotFoundError('x'), REQUEST_ID);

    expect(result.body.error.requestId).toBe(REQUEST_ID);
  });
});

describe('toErrorResponse 的安全边界', () => {
  it('非 AppError 归一化为 INTERNAL_ERROR，且不含原始信息', () => {
    const raw = new Error('connect ECONNREFUSED 10.0.0.5:5432 (postgres)');
    const result = toErrorResponse(raw, REQUEST_ID);

    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('INTERNAL_ERROR');
    expect(result.body.error.message).not.toContain('ECONNREFUSED');
    expect(result.body.error.message).not.toContain('5432');
    expect(result.body.error.message).not.toContain('postgres');
  });

  it('响应体不含堆栈字段', () => {
    const result = toErrorResponse(new InternalError({ cause: new Error('boom') }), REQUEST_ID);

    expect(JSON.stringify(result.body)).not.toMatch(/stack|at\s+\w+\s+\(/);
  });

  it('内部错误的 details 不会进入响应', () => {
    const result = toErrorResponse(
      new InternalError({ details: { sql: 'select 1', table: 'users' } }),
      REQUEST_ID,
    );

    expect(JSON.stringify(result.body)).not.toContain('select 1');
    expect(JSON.stringify(result.body)).not.toContain('users');
  });

  it('requestId 为空时抛错，避免产出无法关联日志的响应', () => {
    expect(() => toErrorResponse(new NotFoundError('x'), '')).toThrow(TypeError);
    expect(() => toErrorResponse(new NotFoundError('x'), '   ')).toThrow(TypeError);
  });
});

describe('toSuccessResponse 与《接口文档》§1.2 一致', () => {
  it('结构与文档示例完全一致', () => {
    const result = toSuccessResponse({ id: 'task-1' }, REQUEST_ID, FIXED_NOW);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      data: { id: 'task-1' },
      meta: {
        requestId: REQUEST_ID,
        serverTime: '2026-09-16T04:00:00.000Z',
      },
    });
  });

  it('serverTime 为 UTC ISO 8601', () => {
    const result = toSuccessResponse(null, REQUEST_ID, FIXED_NOW);

    expect(result.body.meta.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('data 为 undefined 时仍可构造（由调用方决定语义）', () => {
    expect(toSuccessResponse(undefined, REQUEST_ID, FIXED_NOW).body.data).toBeUndefined();
  });

  it('requestId 为空时抛错', () => {
    expect(() => toSuccessResponse({}, '')).toThrow(TypeError);
  });

  it('无效时间抛错', () => {
    expect(() => toSuccessResponse({}, REQUEST_ID, new Date('invalid'))).toThrow(TypeError);
  });
});

describe('响应的不可变性', () => {
  it('返回的响应体被冻结，防止被下游意外改写', () => {
    const errorResult = toErrorResponse(new NotFoundError('x'), REQUEST_ID);
    const successResult = toSuccessResponse({}, REQUEST_ID, FIXED_NOW);

    expect(Object.isFrozen(errorResult.body)).toBe(true);
    expect(Object.isFrozen(errorResult.body.error)).toBe(true);
    expect(Object.isFrozen(successResult.body)).toBe(true);
    expect(Object.isFrozen(successResult.body.meta)).toBe(true);
  });
});
