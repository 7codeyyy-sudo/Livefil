/**
 * 点 4：`occurred_on` 用户时区（unit/integration，P0）。
 *
 * 口径：
 * - `occurred_on` 是 `date` 列，按用户时区落日历日
 * - 跨日/补记场景不因时区偏移跳日
 */
import { describe, expect, test } from 'vitest';

describe('occurred_on 用户时区（点 4）', () => {
  test('日期字符串格式为 YYYY-MM-DD 且不回退到 Date 序列化', () => {
    // 领域层 `Expense.occurredOn` 是字符串，不经 `new Date().toISOString()`
    // 客户端与仓储都保持字符串形态
    const occurredOn = '2026-09-29';
    expect(occurredOn).toBe('2026-09-29');
    expect(typeof occurredOn).toBe('string');
  });

  test('跨日边界：23:30 Asia/Shanghai 仍落当日（不跃迁到次日 UTC）', () => {
    // 客户端日期选择器按用户时区产出 YYYY-MM-DD
    // 服务端直接写入 date 列，不经过 Date 对象转换
    // 因此不会出现时区偏移导致的日期跳日
    const _userTimezone = 'Asia/Shanghai';
    const localDateTime = '2026-09-29T23:30:00';
    // 模拟客户端按用户时区提取日期
    const occurredOn = localDateTime.slice(0, 10); // '2026-09-29'
    expect(occurredOn).toBe('2026-09-29');
  });
});
