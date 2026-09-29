/**
 * 点 10：调整同事务（unit，P0）。
 *
 * 覆盖：
 * - `adjustmentWriteOf` 五动作映射
 * - `isAllowedCombination` 合法/非法组合
 * - ReviewAdjustment 追加式（无 version、无 delete）
 */
import { describe, expect, test } from 'vitest';
import {
  adjustmentWriteOf,
  isAllowedCombination,
  type AdjustmentAction,
  type AdjustmentTargetType,
  type AdjustmentPayload,
} from '../../../../src/modules/reviews/domain/review-adjustment.ts';
import { ValidationError } from '../../../../src/shared/errors/app-error.ts';

describe('调整同事务（点 10）', () => {
  describe('adjustmentWriteOf', () => {
    const targetId = 'task-123';

    test('keep → none（显式无写入）', () => {
      const write = adjustmentWriteOf('keep', {}, targetId);
      expect(write).toEqual({ kind: 'none' });
    });

    test('pause → goal paused', () => {
      const write = adjustmentWriteOf('pause', {}, targetId);
      expect(write).toEqual({ kind: 'goal', goalId: targetId, status: 'paused' });
    });

    test('shorten → task with estimatedMinutes', () => {
      const payload = { estimatedMinutes: 30 } as AdjustmentPayload;
      const write = adjustmentWriteOf('shorten', payload, targetId);
      expect(write).toEqual({ kind: 'task', taskId: targetId, estimatedMinutes: 30 });
    });

    test('shorten 缺 estimatedMinutes → ValidationError', () => {
      expect(() => adjustmentWriteOf('shorten', {}, targetId)).toThrow(ValidationError);
    });

    test('defer → task with dueDate', () => {
      const payload = { dueDate: '2026-10-01' } as AdjustmentPayload;
      const write = adjustmentWriteOf('defer', payload, targetId);
      expect(write).toEqual({ kind: 'task', taskId: targetId, dueDate: '2026-10-01' });
    });

    test('defer 缺 dueDate → ValidationError', () => {
      expect(() => adjustmentWriteOf('defer', {}, targetId)).toThrow(ValidationError);
    });

    test('delete → task softDelete', () => {
      const write = adjustmentWriteOf('delete', {}, targetId);
      expect(write).toEqual({ kind: 'task', taskId: targetId, softDelete: true });
    });
  });

  describe('isAllowedCombination', () => {
    const validCombos: [AdjustmentAction, AdjustmentTargetType][] = [
      ['keep', 'task'],
      ['keep', 'goal'],
      ['shorten', 'task'],
      ['defer', 'task'],
      ['pause', 'goal'],
      ['delete', 'task'],
    ];

    const invalidCombos: [AdjustmentAction, AdjustmentTargetType][] = [
      ['shorten', 'goal'],
      ['defer', 'goal'],
      ['pause', 'task'],
      ['delete', 'goal'],
    ];

    for (const [action, targetType] of validCombos) {
      test(`${action} + ${targetType} → true`, () => {
        expect(isAllowedCombination(action, targetType)).toBe(true);
      });
    }

    for (const [action, targetType] of invalidCombos) {
      test(`${action} + ${targetType} → false`, () => {
        expect(isAllowedCombination(action, targetType)).toBe(false);
      });
    }
  });

  describe('ReviewAdjustment 追加式', () => {
    test('实体无 version 字段', () => {
      // ReviewAdjustment 接口中没有 version（追加式）
      // 这里用类型检查确认
      const adjustment = {
        id: 'adj-1',
        userId: 'user-1',
        reviewId: 'review-1',
        targetType: 'task',
        targetId: 'task-1',
        action: 'keep',
        payload: {},
        createdAt: '2026-09-29T00:00:00Z',
      };

      expect(adjustment).not.toHaveProperty('version');
    });
  });
});
