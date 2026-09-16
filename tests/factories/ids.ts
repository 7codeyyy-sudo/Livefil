/**
 * 测试用 ID 生成器（FND-003）。
 *
 * 产出符合 RFC 4122 v4 形态的 UUID 字符串，与《数据库设计文档》§3 对 `id`
 * 字段的规定一致（`uuid`，客户端可提前生成、跨设备唯一）。
 *
 * 用固定随机源驱动而非 `crypto.randomUUID`：测试需要的是**可复现**的标识，
 * 而不是密码学强度的唯一性；固定种子下同一次运行总是得到同一组 ID，
 * 让快照断言与失败重放成为可能。
 */
import type { RandomSource } from './random.ts';

/** UUID v4 的版本位取值，固定出现在第三组的首位。 */
const UUID_VERSION_NIBBLE = '4';

/**
 * RFC 4122 的变体位取值集合，出现在第四组首位。
 * 取值以二进制 `10xx` 开头，故十六进制只能是 8、9、a、b。
 */
const UUID_VARIANT_NIBBLES = Object.freeze(['8', '9', 'a', 'b']);

/** UUID 各十六进制分组的位数，顺序与标准字符串表示一致。 */
const TIME_LOW_LENGTH = 8;

/** @see TIME_LOW_LENGTH */
const TIME_MID_LENGTH = 4;

/** @see TIME_LOW_LENGTH */
const TIME_HIGH_LENGTH = 4;

/** @see TIME_LOW_LENGTH */
const CLOCK_SEQ_LENGTH = 4;

/** @see TIME_LOW_LENGTH */
const NODE_LENGTH = 12;

export interface IdFactory {
  /** 生成一个新的 UUID v4 字符串。 */
  readonly next: () => string;
}

/**
 * 创建 ID 生成器。
 *
 * @param random 驱动 UUID 各分组的随机源。
 * @returns ID 生成器；已冻结。
 */
export function createIdFactory(random: RandomSource): IdFactory {
  const next = (): string => {
    const timeLow = random.hex(TIME_LOW_LENGTH);
    const timeMid = random.hex(TIME_MID_LENGTH);
    const timeHigh = random.hex(TIME_HIGH_LENGTH);
    const clockSeq = random.hex(CLOCK_SEQ_LENGTH);
    const node = random.hex(NODE_LENGTH);

    // 覆写第三组首位为版本号、第四组首位为变体位，其余位保留随机值。
    const variantNibble = random.pick(UUID_VARIANT_NIBBLES);

    return `${timeLow}-${timeMid}-${UUID_VERSION_NIBBLE}${timeHigh.slice(1)}-${variantNibble}${clockSeq.slice(1)}-${node}`;
  };

  return Object.freeze({ next });
}
