/**
 * 日志脱敏测试（FND-005）。
 *
 * 核心用例是「反例」：喂入含敏感值的对象，断言**输出中不含原文**。
 * 只检查「有没有调用脱敏函数」是没意义的——那种断言在脱敏逻辑写错时照样通过。
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_TEXT_LENGTH,
  REDACTED_PLACEHOLDER,
  isForbiddenFieldName,
  redactRecord,
  redactValue,
} from '@/shared/telemetry/redaction.ts';

describe('禁止字段识别', () => {
  it.each([
    'password',
    'PASSWORD',
    'api_key',
    'apiKey',
    'accessToken',
    'refresh-token',
    'authorization',
    'Cookie',
    'sessionId',
    'clientSecret',
    'privateKey',
    'userPassword',
  ])('字段名 %s 命中禁止清单', (fieldName) => {
    expect(isForbiddenFieldName(fieldName)).toBe(true);
  });

  it.each(['userId', 'requestId', 'route', 'operation', 'durationMs', 'errorCode'])(
    '字段名 %s 不在禁止清单内',
    (fieldName) => {
      expect(isForbiddenFieldName(fieldName)).toBe(false);
    },
  );
});

describe('脱敏结果不含敏感原文', () => {
  it('嵌套对象与数组中的敏感字段同样被替换', () => {
    const context = {
      userId: 'user-1',
      password: 'hunter2',
      nested: { apiKey: 'sk-live-1234567890', note: '正常内容' },
      items: [{ refreshToken: 'rt-abc' }, { name: '正常项' }],
    };

    const redacted = redactRecord(context);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('sk-live-1234567890');
    expect(serialized).not.toContain('rt-abc');

    // 非敏感字段必须保留，否则日志就失去了排查价值。
    expect(redacted.userId).toBe('user-1');
  });

  it('命中禁止清单的字段整体变为占位符，而不是部分遮盖', () => {
    const redacted = redactRecord({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' });

    expect(redacted.authorization).toBe(REDACTED_PLACEHOLDER);
  });
});

describe('文本长度截断', () => {
  it('超长文本被截断并标注丢弃的字符数', () => {
    const longText = 'a'.repeat(MAX_TEXT_LENGTH + 50);
    const result = redactValue(longText, 'note') as string;

    expect(result.length).toBeLessThan(longText.length);
    expect(result).toContain('[TRUNCATED 50 chars]');
    expect(result.startsWith('a'.repeat(MAX_TEXT_LENGTH))).toBe(true);
  });

  it('未超长文本原样保留', () => {
    const shortText = '正常长度的内容';
    expect(redactValue(shortText, 'note')).toBe(shortText);
  });

  it('恰好等于上限的文本不被截断', () => {
    const exact = 'b'.repeat(MAX_TEXT_LENGTH);
    expect(redactValue(exact, 'note')).toBe(exact);
  });
});

describe('各类值的处理', () => {
  it('基本类型原样保留', () => {
    expect(redactValue(42, 'count')).toBe(42);
    expect(redactValue(true, 'flag')).toBe(true);
    expect(redactValue(null, 'empty')).toBeNull();
    expect(redactValue(undefined, 'missing')).toBeUndefined();
  });

  it('Date 转为 UTC ISO 字符串', () => {
    expect(redactValue(new Date('2026-09-16T04:00:00.000Z'), 'at')).toBe(
      '2026-09-16T04:00:00.000Z',
    );
  });

  it('Error 只暴露类型名，不暴露 message 与堆栈', () => {
    const error = new Error('connect ECONNREFUSED 10.0.0.5:5432');
    const result = redactValue(error, 'failure');

    expect(result).toEqual({ name: 'Error' });
    expect(JSON.stringify(result)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(result)).not.toContain('5432');
  });

  it('无法序列化的值记录其类型而不抛错', () => {
    expect(redactValue(() => undefined, 'callback')).toBe('[UNSERIALIZABLE:function]');
  });
});

describe('结构性边界', () => {
  it('超过深度上限时截断，不无限递归', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 'deep' } } } } } } } };
    const result = redactValue(deep, 'root');

    expect(JSON.stringify(result)).toContain('[TRUNCATED:MAX_DEPTH]');
  });

  it('超长数组被截断并标注剩余条数', () => {
    const items = Array.from({ length: 60 }, (_, index) => index);
    const result = redactValue(items, 'items') as readonly unknown[];

    // 50 条数据 + 1 条截断标记
    expect(result).toHaveLength(51);
    expect(String(result.at(-1))).toContain('10 more items');
  });

  it('空对象与空数组不会报错', () => {
    expect(redactValue({}, 'emptyObject')).toEqual({});
    expect(redactValue([], 'emptyArray')).toEqual([]);
    expect(redactRecord({})).toEqual({});
  });
});

describe('不修改原对象', () => {
  it('脱敏返回新对象，原对象保持不变', () => {
    const original = { password: 'hunter2', userId: 'user-1' };
    const redacted = redactRecord(original);

    expect(original.password).toBe('hunter2');
    expect(redacted).not.toBe(original);
  });
});
