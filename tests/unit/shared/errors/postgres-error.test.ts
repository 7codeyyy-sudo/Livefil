/**
 * 错误码沿 cause 链识别回归护栏（缺陷 1）。
 */
import { describe, expect, it } from 'vitest';
import { hasPostgresErrorCode } from '@/shared/errors/postgres-error.ts';

function wrapWithCode(innerCode: string, depth: number): unknown {
  let current: unknown = { code: innerCode };
  for (let i = 0; i < depth; i += 1) {
    current = { cause: current, code: undefined };
  }
  return current;
}

describe('hasPostgresErrorCode', () => {
  it('单层包装 23505 能识别', () => {
    expect(hasPostgresErrorCode(wrapWithCode('23505', 1), '23505')).toBe(true);
  });

  it('多层包装 23503 能识别', () => {
    expect(hasPostgresErrorCode(wrapWithCode('23503', 3), '23503')).toBe(true);
  });

  it('不匹配码返回 false', () => {
    expect(hasPostgresErrorCode(wrapWithCode('23505', 1), '23503')).toBe(false);
  });

  it('cause 成环时安全退出', () => {
    const err: Record<string, unknown> = { code: '23505' };
    err.cause = err;
    expect(hasPostgresErrorCode(err, '23505')).toBe(true);
  });

  it('超深度包装仍能识别', () => {
    // MAX_CAUSE_DEPTH=8，循环检查 0..7 层； depth=7 时 code 落在第 7 层，刚好是边界。
    expect(hasPostgresErrorCode(wrapWithCode('23505', 7), '23505')).toBe(true);
  });

  it('非对象入参不抛错', () => {
    expect(hasPostgresErrorCode(null, '23505')).toBe(false);
    expect(hasPostgresErrorCode(undefined, '23505')).toBe(false);
    expect(hasPostgresErrorCode('string', '23505')).toBe(false);
    expect(hasPostgresErrorCode(123, '23505')).toBe(false);
  });
});
