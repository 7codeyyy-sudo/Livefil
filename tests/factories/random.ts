/**
 * 测试用确定性随机源（FND-003）。
 *
 * 为什么不用 `Math.random`：测试一旦依赖不可复现的随机值，失败就无法重放，
 * 「偶发失败」也会被误判成不稳定测试而不是真实缺陷。这里用固定种子驱动的
 * 伪随机序列（mulberry32），同一种子**永远**产出同一组数据。
 *
 * 设计约束：
 * - 不引入第三方依赖。本模块是测试基础设施的底座，自身不应成为依赖风险面。
 * - 越界输入一律显式抛错，不静默纠正。辅助代码替调用方「修正」参数，
 *   会把调用方的错误藏起来，最终表现为难以定位的数据异常。
 */

/** 默认种子。取固定值而非时间戳，保证「不传种子」同样可复现。 */
const DEFAULT_SEED = 20260916;

/** mulberry32 的状态增量与归一化除数（算法自身的标准常量）。 */
const MULBERRY_INCREMENT = 0x6d2b79f5;

/** 2^32，用于把 32 位无符号整数映射回 [0, 1)；同时是位运算的安全边界。 */
const UINT32_MODULUS = 4294967296;

/** FNV-1a 32 位哈希的初始值与质数乘子（算法自身的标准常量）。 */
const FNV_OFFSET_BASIS = 0x811c9dc5;

/** @see FNV_OFFSET_BASIS */
const FNV_PRIME = 0x01000193;

/** 十六进制进制数，用于把随机整数渲染成单个十六进制字符。 */
const HEX_RADIX = 16;

/** 布尔型取值的默认概率。 */
const DEFAULT_PROBABILITY = 0.5;

export interface RandomSource {
  /** 返回 [0, 1) 区间内的下一个伪随机浮点数。 */
  readonly next: () => number;
  /** 以 `probability`（默认 0.5）为概率返回布尔值。 */
  readonly bool: (probability?: number) => boolean;
  /** 返回 `[min, max]` 闭区间内的整数。 */
  readonly int: (min: number, max: number) => number;
  /** 从非空集合中均匀取一个元素。 */
  readonly pick: <T>(items: readonly T[]) => T;
  /** 返回指定长度的随机十六进制字符串（小写）。 */
  readonly hex: (length: number) => string;
}

/**
 * 把任意种子折叠成 32 位无符号整数。
 *
 * @param seed 数值或字符串种子。
 * @returns 可直接作为伪随机状态初值的 32 位无符号整数。
 * @throws {TypeError} 种子为非有限数值时抛出。
 */
function hashSeed(seed: number | string): number {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) {
      throw new TypeError(`随机种子必须是有限数值，实际收到 ${String(seed)}`);
    }
    return Math.trunc(seed) >>> 0;
  }

  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * mulberry32 伪随机数发生器。
 *
 * 选它的原因：实现短、状态仅 32 位、分布质量足以生成测试数据，且无需依赖。
 *
 * @param seed 32 位无符号整数种子。
 * @returns 每次调用返回 [0, 1) 区间浮点数的函数。
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_MODULUS;
  };
}

/**
 * 创建确定性随机源。
 *
 * @param seed 种子；同一字符串或数值种子总是产出同一序列。
 * @returns 随机源；其方法均已冻结。
 * @throws {TypeError} 种子为非有限数值时抛出。
 */
export function createRandom(seed: number | string = DEFAULT_SEED): RandomSource {
  const draw = mulberry32(hashSeed(seed));

  const next = (): number => draw();

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new TypeError(`int 的边界必须是整数，实际收到 min=${String(min)}、max=${String(max)}`);
    }
    if (max < min) {
      throw new RangeError(`int 的上界不得小于下界，实际收到 min=${min}、max=${max}`);
    }
    return min + Math.floor(next() * (max - min + 1));
  };

  const bool = (probability: number = DEFAULT_PROBABILITY): boolean => {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError(`bool 的概率必须落在 [0, 1]，实际收到 ${String(probability)}`);
    }
    return next() < probability;
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) {
      throw new RangeError('pick 无法从空集合中取值');
    }

    const index = int(0, items.length - 1);
    const value = items[index];
    if (value === undefined) {
      // int 已保证索引落在区间内，走到这里说明随机源自身失效，属于内部不变量破坏。
      throw new RangeError(`pick 取到越界索引 ${index}（集合长度 ${items.length}）`);
    }
    return value;
  };

  const hex = (length: number): string => {
    if (!Number.isInteger(length) || length < 0) {
      throw new RangeError(`hex 的长度必须是非负整数，实际收到 ${String(length)}`);
    }

    let result = '';
    for (let index = 0; index < length; index += 1) {
      result += int(0, HEX_RADIX - 1).toString(HEX_RADIX);
    }
    return result;
  };

  return Object.freeze({ next, bool, int, pick, hex });
}
