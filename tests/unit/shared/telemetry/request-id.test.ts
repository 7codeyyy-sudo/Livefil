/**
 * 请求 ID 测试（FND-005）。
 *
 * 这里的安全用例和功能用例一样重要：`X-Request-Id` 来自不可信来源，
 * 而它的值会被回写进响应头与日志。一个含换行的值就是一次头注入或日志注入。
 */
import { describe, expect, it } from 'vitest';

import {
  REQUEST_ID_HEADER,
  createRequestId,
  isValidRequestId,
  resolveRequestId,
} from '@/shared/telemetry/request-id.ts';

/** UUID v4 的形态，与实现使用的正则同源但独立书写，避免「测试跟随实现」而失去意义。 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('请求头名称', () => {
  it('与《接口文档》§1.1 约定一致', () => {
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
  });
});

describe('createRequestId', () => {
  it('产出的值是 UUID v4', () => {
    expect(createRequestId()).toMatch(UUID_V4);
  });

  it('连续生成的值互不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createRequestId()));

    expect(ids.size).toBe(200);
  });
});

describe('isValidRequestId', () => {
  it('接受合法的 UUID v4（大小写均可）', () => {
    expect(isValidRequestId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidRequestId('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it.each([
    ['空字符串', ''],
    ['文档中的占位示例', 'req_123'],
    ['缺少分组', '550e8400e29b41d4a716446655440000'],
    ['版本位不是 4', '550e8400-e29b-31d4-a716-446655440000'],
    ['变体位非法', '550e8400-e29b-41d4-c716-446655440000'],
    ['含换行（头注入风险）', '550e8400-e29b-41d4-a716-446655440000\nX-Injected: 1'],
    ['含控制字符', '550e8400-e29b-41d4-a716-44665544000\u0000'],
    ['纯空白', '   '],
    ['超长随机串', 'a'.repeat(500)],
  ])('拒绝%s', (_label, value) => {
    expect(isValidRequestId(value)).toBe(false);
  });
});

describe('resolveRequestId', () => {
  it('合法值被采纳', () => {
    const provided = '550e8400-e29b-41d4-a716-446655440000';
    expect(resolveRequestId(provided)).toBe(provided);
  });

  it('两侧空白被忽略后仍采纳', () => {
    const provided = '  550e8400-e29b-41d4-a716-446655440000  ';
    expect(resolveRequestId(provided)).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it.each([
    ['头不存在（null）', null],
    ['头不存在（undefined）', undefined],
    ['空字符串', ''],
    ['非法格式', 'req_123'],
    ['含换行', '550e8400-e29b-41d4-a716-446655440000\nevil'],
  ])('%s 时生成新的合法 ID', (_label, value) => {
    const resolved = resolveRequestId(value);

    expect(resolved).toMatch(UUID_V4);
    // 非法值绝不能被原样采纳，否则会把注入内容带进响应头与日志。
    expect(resolved).not.toContain('evil');
  });

  it('生成的新 ID 每次不同', () => {
    expect(resolveRequestId(null)).not.toBe(resolveRequestId(null));
  });
});
