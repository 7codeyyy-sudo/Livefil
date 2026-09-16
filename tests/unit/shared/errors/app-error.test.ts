/**
 * 应用错误类型体系测试（FND-005）。
 *
 * 两类断言缺一不可：
 * - **契约一致性**：每个错误码都有类承载、且 code 与 HTTP 状态与《接口文档》§1.4 一致。
 * - **安全边界**：非 AppError 的错误不得把原始 message 透出——那是 SQL、路径与
 *   用户内容泄露的主要路径（SRS NFR-SEC-007）。
 */
import { describe, expect, it } from 'vitest';

import {
  AppError,
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
  toAppError,
} from '@/shared/errors/app-error.ts';
import { ERROR_CODES, type ErrorCode } from '@/shared/errors/error-code.ts';

interface ContractErrorCase {
  readonly code: ErrorCode;
  readonly status: number;
  readonly create: () => AppError;
}

/**
 * 契约错误：与《接口文档》§1.4 的错误码表一一对应。
 *
 * 这张表就是「接口文档 ↔ 代码」的对照，改动它等同于改动对外契约。
 */
const CONTRACT_ERROR_CASES: readonly ContractErrorCase[] = [
  { code: 'VALIDATION_ERROR', status: 400, create: () => new ValidationError('输入不合法') },
  { code: 'AUTHENTICATION_REQUIRED', status: 401, create: () => new AuthenticationError('未登录') },
  { code: 'FORBIDDEN', status: 403, create: () => new AuthorizationError('无权访问') },
  { code: 'NOT_FOUND', status: 404, create: () => new NotFoundError('资源不存在') },
  { code: 'CONFLICT', status: 409, create: () => new ConflictError('版本冲突') },
  { code: 'IDEMPOTENCY_REPLAY', status: 409, create: () => new IdempotencyReplayError('已处理') },
  { code: 'RATE_LIMITED', status: 429, create: () => new RateLimitError('超过限额') },
  {
    code: 'DEPENDENCY_UNAVAILABLE',
    status: 502,
    create: () => new DependencyUnavailableError('外部服务不可用'),
  },
  {
    code: 'DEPENDENCY_TIMEOUT',
    status: 504,
    create: () => new DependencyTimeoutError('外部服务超时'),
  },
  { code: 'INTERNAL_ERROR', status: 500, create: () => new InternalError() },
];

describe('契约错误与错误码一一对应', () => {
  it('每个错误码都有错误类承载', () => {
    const coveredCodes = CONTRACT_ERROR_CASES.map((testCase) => testCase.code).sort();

    // 与 ERROR_CODES 双向比对：少一个类、或多出一个未登记的码，都会在这里失败。
    expect(coveredCodes).toEqual([...ERROR_CODES].sort());
  });

  it.each(CONTRACT_ERROR_CASES)('$code 映射到 HTTP $status', ({ code, status, create }) => {
    const error = create();

    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
  });

  it.each(CONTRACT_ERROR_CASES)('$code 的实例是 AppError', ({ create }) => {
    expect(create()).toBeInstanceOf(AppError);
  });
});

describe('错误对象的基本形态', () => {
  it('name 取自具体子类，便于日志与堆栈识别', () => {
    expect(new ValidationError('x').name).toBe('ValidationError');
    expect(new DependencyTimeoutError('x').name).toBe('DependencyTimeoutError');
    expect(new DatabaseError().name).toBe('DatabaseError');
  });

  it('fields 与 details 原样保留且可缺省', () => {
    const withFields = new ValidationError('标题不能为空', {
      fields: { title: 'required' },
    });
    expect(withFields.fields).toEqual({ title: 'required' });
    expect(withFields.details).toBeUndefined();

    const withDetails = new ConflictError('版本冲突', {
      details: { expectedVersion: 3, actualVersion: 5 },
    });
    expect(withDetails.details).toEqual({ expectedVersion: 3, actualVersion: 5 });
  });

  it('cause 被保留为标准 Error.cause', () => {
    const rootCause = new TypeError('原始类型错误');
    expect(new InternalError({ cause: rootCause }).cause).toBe(rootCause);
  });

  it('未提供 cause 时不产生 cause 属性', () => {
    expect(new ValidationError('x').cause).toBeUndefined();
  });
});

describe('内部错误的对外归一化', () => {
  it('DatabaseError 与 InvariantError 对外都是 INTERNAL_ERROR', () => {
    expect(new DatabaseError().code).toBe('INTERNAL_ERROR');
    expect(new DatabaseError().httpStatus).toBe(500);
    expect(new InvariantError().code).toBe('INTERNAL_ERROR');
    expect(new InvariantError().httpStatus).toBe(500);
  });

  it('内部错误仍可被精确捕获', () => {
    const databaseError = new DatabaseError();

    // 既能按内部类别捕获（决定重试与告警），也能按对外语义捕获（统一处理）。
    expect(databaseError).toBeInstanceOf(DatabaseError);
    expect(databaseError).toBeInstanceOf(InternalError);
    expect(databaseError).toBeInstanceOf(AppError);
  });

  it('默认文案不含任何内部结构信息', () => {
    const message = new DatabaseError().message;

    expect(message).not.toMatch(/sql|select|insert|table|postgres|password/i);
  });
});

describe('toAppError 归一化', () => {
  it('AppError 原样返回，不做包装', () => {
    const original = new NotFoundError('资源不存在');
    expect(toAppError(original)).toBe(original);
  });

  it('普通 Error 归一化为 INTERNAL_ERROR，且不泄露原始 message', () => {
    const raw = new Error('select * from users where token = "abc"');
    const normalized = toAppError(raw);

    expect(normalized).toBeInstanceOf(InternalError);
    expect(normalized.code).toBe('INTERNAL_ERROR');
    // 关键断言：原始 message 绝不能出现在对外文案里。
    expect(normalized.message).not.toContain('select * from users');
    expect(normalized.message).not.toContain('abc');
  });

  it('非 Error 的抛出物同样被归一化', () => {
    for (const thrown of ['字符串错误', 42, null, undefined, { code: 'X' }]) {
      const normalized = toAppError(thrown);
      expect(normalized.code).toBe('INTERNAL_ERROR');
    }
  });

  it('原始错误仅通过 cause 保留，供服务端追溯', () => {
    const raw = new Error('内部细节');
    expect(toAppError(raw).cause).toBe(raw);
  });
});

describe('空数据与边界', () => {
  it('空字符串消息不会让构造失败', () => {
    expect(new ValidationError('').message).toBe('');
  });

  it('空 fields 对象与缺省 fields 在类型上可区分', () => {
    expect(new ValidationError('x', { fields: {} }).fields).toEqual({});
    expect(new ValidationError('x').fields).toBeUndefined();
  });
});
