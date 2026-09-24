/**
 * sync-apply 墓碑与合并规则（测试点 9、12）。
 */
import { describe, expect, it } from 'vitest';
import {
  SYNC_CASCADE_RULES,
  type SyncCascadeRule,
  childEntityTypesOf,
  readParentEntityId,
} from '@/modules/sync/domain/local-store.ts';

describe('sync-apply 规则', () => {
  const rules: readonly SyncCascadeRule[] = SYNC_CASCADE_RULES;

  it('childEntityTypesOf 返回直接子类型', () => {
    expect(childEntityTypesOf('goal')).toEqual([]);
    expect(childEntityTypesOf('routine')).toEqual(['routine_step']);
    expect(childEntityTypesOf('task')).toEqual([]);
  });

  it('readParentEntityId 读取父级 ID', () => {
    expect(readParentEntityId('routine_step', { routineId: 'r1' })).toBe('r1');
    expect(readParentEntityId('action', { goalId: 'g1' })).toBeNull();
    expect(readParentEntityId('task', {})).toBeNull();
  });

  it('SYNC_CASCADE_RULES 定义级联类型', () => {
    expect(rules.some((r) => r.parent === 'routine' && r.child === 'routine_step')).toBe(true);
    expect(rules.find((r) => r.parent === 'goal')).toBeUndefined();
  });
});
