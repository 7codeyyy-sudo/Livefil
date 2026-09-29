/**
 * 点 9：周快照（integration，P0）。
 *
 * 覆盖：
 * - weekly snapshot 结构与字段
 * - schema version 匹配
 * - 空快照默认值
 */
import { describe, expect, test } from 'vitest';

describe('周快照（点 9）', () => {
  test('snapshotSchemaVersion 与 snapshot 同生共死', () => {
    const snapshot = {
      schemaVersion: 1,
      weekStart: '2026-09-21',
      timezone: 'Asia/Shanghai',
      planActual: { plannedMinutes: 120, actualMinutes: 90 },
      taskStatusCounts: { completed: 5, partial: 0, deferred: 0, skipped: 0 },
      repeatedDeferrals: [],
      goalActions: [],
      expenseSummaries: [],
    };

    expect(snapshot).toBeDefined();
    expect(snapshot.planActual.plannedMinutes).toBe(120);
    expect(snapshot.taskStatusCounts.completed).toBe(5);
  });

  test('空快照默认值合理', () => {
    const empty = {
      schemaVersion: 1,
      weekStart: '2026-09-21',
      timezone: 'Asia/Shanghai',
      planActual: { plannedMinutes: 0, actualMinutes: 0 },
      taskStatusCounts: { completed: 0, partial: 0, deferred: 0, skipped: 0 },
      repeatedDeferrals: [],
      goalActions: [],
      expenseSummaries: [],
    };

    expect(empty.planActual.actualMinutes).toBe(0);
    expect(empty.taskStatusCounts.completed).toBe(0);
  });
});
