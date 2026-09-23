/**
 * Phase 4 领域纯函数单测（审查整改：新增业务逻辑必须带覆盖）。
 */
import { describe, expect, it } from 'vitest';

import {
  expandRuleDates,
  parseRecurrenceRule,
  ruleMatchesDate,
} from '@/modules/scheduling/domain/recurrence.ts';
import {
  detectBlockConflicts,
  detectFixedConflicts,
} from '@/modules/scheduling/domain/conflict.ts';
import type { ScheduleBlock } from '@/modules/scheduling/domain/schedule-block.ts';
import {
  assertExecutionLogInput,
  blockStatusForLog,
  taskStatusForLog,
} from '@/modules/execution/domain/execution-log.ts';
import {
  buildRecoverySuggestions,
  detectAutoTrigger,
} from '@/modules/execution/domain/recovery.ts';

function block(overrides: Partial<ScheduleBlock> = {}): ScheduleBlock {
  return {
    id: 'b1',
    userId: 'u1',
    taskId: null,
    actionId: null,
    routineId: null,
    routineStepId: null,
    startsAtUtc: new Date('2026-09-22T01:00:00Z'),
    endsAtUtc: new Date('2026-09-22T02:00:00Z'),
    timezone: 'Asia/Shanghai',
    source: 'manual',
    status: 'planned',
    conflictState: 'none',
    version: 1,
    ...overrides,
  };
}

describe('重复规则（阻塞 1 回归：weekly 整周多 weekday 命中）', () => {
  it('周一至周五、锚点周二：整周命中全部工作日而非仅周二', () => {
    const rule = parseRecurrenceRule({ freq: 'weekly', weekdays: [1, 2, 3, 4, 5] });
    // 锚点 2026-09-22 是周二。
    const hits = expandRuleDates(rule, '2026-09-22', '2026-09-22', '2026-09-28');
    expect(hits).toEqual([
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      // 09-26（六）、09-27（日）不命中；09-28（下周一）命中。
      '2026-09-28',
    ]);
    expect(hits).toHaveLength(5);
  });

  it('daily interval=2：隔天命中', () => {
    const rule = parseRecurrenceRule({ freq: 'daily', interval: 2 });
    const hits = expandRuleDates(rule, '2026-09-22', '2026-09-22', '2026-09-27');
    expect(hits).toEqual(['2026-09-22', '2026-09-24', '2026-09-26']);
  });

  it('endsOn 之后不再展开；daily 不允许 weekdays', () => {
    const rule = parseRecurrenceRule({ freq: 'daily', endsOn: '2026-09-24' });
    expect(ruleMatchesDate(rule, '2026-09-22', '2026-09-25')).toBe(false);
    expect(() => parseRecurrenceRule({ freq: 'daily', weekdays: [1] })).toThrow();
  });
});

describe('冲突检测：半开区间（相邻不撞）', () => {
  it('相邻（前块结束=候选开始）不冲突；重叠才冲突', () => {
    const adjacent = block({
      id: 'adjacent',
      startsAtUtc: new Date('2026-09-22T00:00:00Z'),
      endsAtUtc: new Date('2026-09-22T01:00:00Z'),
    });
    expect(
      detectBlockConflicts(
        {
          startsAtUtc: new Date('2026-09-22T01:00:00Z'),
          endsAtUtc: new Date('2026-09-22T02:00:00Z'),
        },
        [adjacent],
      ),
    ).toHaveLength(0);

    const overlapping = block({ id: 'overlap' });
    const conflicts = detectBlockConflicts(
      {
        startsAtUtc: new Date('2026-09-22T01:30:00Z'),
        endsAtUtc: new Date('2026-09-22T03:00:00Z'),
      },
      [overlapping],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.id).toBe('overlap');
  });

  it('cancelled 块不参与；固定事项冲突 kind=fixed', () => {
    expect(
      detectBlockConflicts(
        {
          startsAtUtc: new Date('2026-09-22T01:00:00Z'),
          endsAtUtc: new Date('2026-09-22T02:00:00Z'),
        },
        [block({ status: 'cancelled' })],
      ),
    ).toHaveLength(0);
    const conflicts = detectFixedConflicts(
      {
        startsAtUtc: new Date('2026-09-22T01:00:00Z'),
        endsAtUtc: new Date('2026-09-22T02:00:00Z'),
      },
      [
        {
          id: 'f1',
          userId: 'u1',
          title: '坐班',
          templateId: null,
          localDate: '2026-09-22',
          startsAtUtc: new Date('2026-09-22T00:00:00Z'),
          endsAtUtc: new Date('2026-09-22T09:00:00Z'),
          startsAtLocal: null,
          durationMinutes: 540,
          timezone: 'Asia/Shanghai',
          recurrenceRule: null,
          deletedAt: null,
          createdAt: '2026-09-21T00:00:00.000Z',
          version: 1,
        },
      ],
    );
    expect(conflicts[0]?.kind).toBe('fixed');
  });
});

describe('执行记录：输入校验与状态联动', () => {
  it('action-only 合法（习惯打卡，阻塞 4 定档）；三者全空才拒绝', () => {
    expect(() =>
      assertExecutionLogInput({
        taskId: null,
        actionId: 'a1',
        scheduleBlockId: null,
        status: 'completed',
        plannedMinutes: null,
        actualMinutes: null,
        reasonCode: null,
        note: null,
        energyLevel: null,
        moodScore: null,
        occurredAt: new Date(),
      }),
    ).not.toThrow();
    expect(() =>
      assertExecutionLogInput({
        taskId: null,
        actionId: null,
        scheduleBlockId: null,
        status: 'completed',
        plannedMinutes: null,
        actualMinutes: null,
        reasonCode: null,
        note: null,
        energyLevel: null,
        moodScore: null,
        occurredAt: new Date(),
      }),
    ).toThrow();
  });

  it('reasonCode 仅 partial/deferred/skipped 可带；联动映射正确', () => {
    expect(() =>
      assertExecutionLogInput({
        taskId: 't1',
        actionId: null,
        scheduleBlockId: null,
        status: 'completed',
        plannedMinutes: null,
        actualMinutes: null,
        reasonCode: 'NO_ENERGY',
        note: null,
        energyLevel: null,
        moodScore: null,
        occurredAt: new Date(),
      }),
    ).toThrow();
    expect(taskStatusForLog('minimum_completed')).toBe('completed');
    expect(blockStatusForLog('partial')).toBe('completed');
    expect(blockStatusForLog('skipped')).toBe('cancelled');
  });
});

describe('恢复模式：自动触发与建议顺序', () => {
  it('最近 2 个有计划日完成率 <50% 才自动触发', () => {
    const low = { date: '2026-09-21', plannedMinutes: 100, completedMinutes: 20 };
    expect(detectAutoTrigger([low, { ...low, date: '2026-09-22' }])).toBe(true);
    expect(detectAutoTrigger([low, { ...low, date: '2026-09-22', completedMinutes: 80 }])).toBe(
      false,
    );
    expect(detectAutoTrigger([low])).toBe(false);
  });

  it('建议顺序 SHRINK→MINIMUM→RESCHEDULE→PAUSE', () => {
    const blocks = [
      {
        id: 'b-long',
        title: '长任务',
        status: 'planned' as const,
        endsAtUtc: new Date('2026-09-22T03:00:00Z'),
        durationMinutes: 120,
        taskId: 't1',
        minimumVersion: null as string | null,
      },
      {
        id: 'b-mv',
        title: '有最低版本',
        status: 'planned' as const,
        endsAtUtc: new Date('2026-09-22T02:00:00Z'),
        durationMinutes: 30,
        taskId: 't2',
        minimumVersion: '走路 8 分钟' as string | null,
      },
    ];
    const past = buildRecoverySuggestions({
      blocks,
      now: new Date('2026-09-22T04:00:00Z'),
      overloaded: true,
      freeSlots: [
        { start: new Date('2026-09-22T04:00:00Z'), end: new Date('2026-09-22T06:00:00Z') },
      ],
    });
    expect(past.map((s) => s.code)).toEqual(['SHRINK', 'MINIMUM', 'RESCHEDULE']);
    // 无空档 → PAUSE。
    const paused = buildRecoverySuggestions({
      blocks,
      now: new Date('2026-09-22T04:00:00Z'),
      overloaded: false,
      freeSlots: [],
    });
    expect(paused.map((s) => s.code)).toEqual(['MINIMUM', 'PAUSE']);
  });
});
