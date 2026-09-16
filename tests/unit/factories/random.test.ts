/**
 * 随机源单元测试（FND-003）。
 *
 * 重点覆盖两类风险：
 * 1. **可复现性**——同一种子必须产出同一序列，否则测试失败无法重放，
 *    也就失去了「固定种子」的全部意义。
 * 2. **边界校验**——越界输入必须显式抛错，而不是静默产出非法数据。
 *    测试辅助代码静默纠正参数，会把调用方的错误推迟到断言阶段才暴露。
 */
import { describe, expect, it } from 'vitest';

import { createRandom } from '../../factories/random.ts';

/** 连续取样次数，用于验证值域与分布性质的边界。 */
const SAMPLE_COUNT = 1000;

describe('createRandom 的可复现性', () => {
  it('同一种子产出完全相同的序列', () => {
    const first = createRandom('seed-alpha');
    const second = createRandom('seed-alpha');

    const firstSequence = Array.from({ length: SAMPLE_COUNT }, () => first.next());
    const secondSequence = Array.from({ length: SAMPLE_COUNT }, () => second.next());

    expect(firstSequence).toEqual(secondSequence);
  });

  it('数值种子与字符串种子各自稳定', () => {
    expect(createRandom(2026).next()).toBe(createRandom(2026).next());
    expect(createRandom('2026').next()).toBe(createRandom('2026').next());
  });

  it('不同种子产出不同序列', () => {
    const left = createRandom('seed-a');
    const right = createRandom('seed-b');

    const leftSequence = Array.from({ length: 10 }, () => left.next());
    const rightSequence = Array.from({ length: 10 }, () => right.next());

    expect(leftSequence).not.toEqual(rightSequence);
  });

  it('缺省种子同样可复现', () => {
    expect(createRandom().next()).toBe(createRandom().next());
  });

  it('拒绝非有限数值种子', () => {
    expect(() => createRandom(Number.NaN)).toThrow(TypeError);
    expect(() => createRandom(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('createRandom.next 的值域', () => {
  it('始终落在 [0, 1)', () => {
    const random = createRandom(7);

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const value = random.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('createRandom.int', () => {
  it('结果始终是闭区间内的整数', () => {
    const random = createRandom(11);

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const value = random.int(-5, 5);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(-5);
      expect(value).toBeLessThanOrEqual(5);
    }
  });

  it('上下界都能取到（区间未被开区间化）', () => {
    const random = createRandom(13);
    const seen = new Set<number>();

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      seen.add(random.int(0, 2));
    }

    expect([...seen].sort()).toEqual([0, 1, 2]);
  });

  it('允许上下界相等的单点区间', () => {
    expect(createRandom(1).int(4, 4)).toBe(4);
  });

  it('拒绝非整数边界', () => {
    expect(() => createRandom(1).int(0.5, 3)).toThrow(TypeError);
  });

  it('拒绝上界小于下界', () => {
    expect(() => createRandom(1).int(3, 1)).toThrow(RangeError);
  });
});

describe('createRandom.bool', () => {
  it('概率为 0 时恒为 false、为 1 时恒为 true', () => {
    const random = createRandom(17);

    for (let index = 0; index < 100; index += 1) {
      expect(random.bool(0)).toBe(false);
      expect(random.bool(1)).toBe(true);
    }
  });

  it('拒绝落在 [0, 1] 之外的概率', () => {
    expect(() => createRandom(1).bool(-0.1)).toThrow(RangeError);
    expect(() => createRandom(1).bool(1.1)).toThrow(RangeError);
  });
});

describe('createRandom.pick', () => {
  it('只从给定集合中取值', () => {
    const random = createRandom(19);
    const items = ['a', 'b', 'c'];

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      expect(items).toContain(random.pick(items));
    }
  });

  it('拒绝空集合', () => {
    // 空集合取值没有任何合理默认值，必须失败而不是返回 undefined。
    expect(() => createRandom(1).pick([] as readonly string[])).toThrow(RangeError);
  });
});

describe('createRandom.hex', () => {
  it('产出指定长度的小写十六进制串', () => {
    const random = createRandom(23);

    for (const length of [0, 1, 8, 32]) {
      const value = random.hex(length);
      expect(value).toHaveLength(length);
      expect(value).toMatch(/^[0-9a-f]*$/);
    }
  });

  it('拒绝负数或非整数长度', () => {
    expect(() => createRandom(1).hex(-1)).toThrow(RangeError);
    expect(() => createRandom(1).hex(1.5)).toThrow(RangeError);
  });
});
