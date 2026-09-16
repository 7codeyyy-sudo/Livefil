/**
 * 测试数据清理契约的单元测试（FND-003）。
 *
 * 这个模块当前的全部价值就在于「明确地不可用」。因此测试的重点不是清理功能，
 * 而是**它必须失败**——一旦有人把 `clean()` 改成静默返回，这些用例会立刻报错，
 * 从而拦住「测试以为数据被清理了、实际没有」这类最危险的假阳性。
 */
import { describe, expect, it } from 'vitest';

import { createFactories } from '../../factories/index.ts';
import {
  CleanupUnavailableError,
  createTestDataCleaner,
  createUnavailableCleaner,
} from '../../helpers/cleanup.ts';
import type { DataReference } from '../../helpers/cleanup.ts';

/** 用例中复用的不可用原因，与实际调用点保持同一措辞。 */
const UNAVAILABLE_REASON = '尚未接入数据库';

describe('不可用清理器', () => {
  it('显式声明不具备清理能力', () => {
    const cleaner = createUnavailableCleaner(UNAVAILABLE_REASON);

    expect(cleaner.isAvailable).toBe(false);
  });

  it('调用清理时抛错，而不是静默成功', async () => {
    const cleaner = createUnavailableCleaner(UNAVAILABLE_REASON);

    await expect(cleaner.clean()).rejects.toBeInstanceOf(CleanupUnavailableError);
    await expect(cleaner.clean()).rejects.toThrow(UNAVAILABLE_REASON);
  });

  it('登记的数据引用可被读取，且返回的是副本', () => {
    const cleaner = createUnavailableCleaner(UNAVAILABLE_REASON);
    cleaner.register({ table: 'tasks', id: 'task-1' });

    const firstRead = cleaner.pendingReferences();
    expect(firstRead).toEqual([{ table: 'tasks', id: 'task-1' }]);

    // 返回副本的意义：调用方改动读取结果不应影响清理器内部状态，
    // 否则一次无心的数组操作就会让待清理清单失真。
    const mutable = firstRead as DataReference[];
    mutable.push({ table: 'goals', id: 'goal-1' });

    expect(cleaner.pendingReferences()).toHaveLength(1);
  });

  it('拒绝表名或主键为空的引用', () => {
    const cleaner = createUnavailableCleaner(UNAVAILABLE_REASON);

    expect(() => cleaner.register({ table: '', id: 'task-1' })).toThrow(TypeError);
    expect(() => cleaner.register({ table: 'tasks', id: '   ' })).toThrow(TypeError);
  });
});

describe('按工厂上下文构造的清理器', () => {
  it('当前阶段明确不可用，并说明原因', async () => {
    const factories = createFactories({ seed: 21 });
    const cleaner = createTestDataCleaner({
      random: factories.random,
      ids: factories.ids,
      clock: factories.clock,
    });

    expect(cleaner.isAvailable).toBe(false);
    await expect(cleaner.clean()).rejects.toBeInstanceOf(CleanupUnavailableError);
  });
});
