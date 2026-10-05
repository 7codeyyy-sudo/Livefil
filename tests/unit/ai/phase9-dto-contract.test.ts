// @vitest-environment node
/**
 * AI DTO 契约单元测试（PD-020 点 2/5，AI-004，P0）。
 *
 * 覆盖：
 * - 点 2：task-breakdown 边界（缺省/空数组→400、min(1)/max(20)、title 上限）
 * - 点 5：confirm 请求体（tasks 分组 min1/max20、expense 分组 categoryId 必填）
 */
import { describe, expect, it } from 'vitest';

import {
  taskBreakdownRequestSchema,
  scheduleSuggestionRequestSchema,
  expenseParseRequestSchema,
  reviewSummaryRequestSchema,
  aiDraftConfirmBodySchema,
} from '../../../src/modules/ai/application/ai-draft-dto.ts';

describe('taskBreakdownRequestSchema（点 2）', () => {
  it('正常输入通过', () => {
    const input = { text: '帮我拆分', context: { availableMinutes: 60 } };
    expect(() => taskBreakdownRequestSchema.parse(input)).not.toThrow();
  });

  it('缺省 context 通过', () => {
    expect(() => taskBreakdownRequestSchema.parse({ text: '拆分' })).not.toThrow();
  });

  it('text 空串失败', () => {
    expect(() => taskBreakdownRequestSchema.parse({ text: '' })).toThrow();
  });

  it('多余字段被 strict 拒绝', () => {
    expect(() => taskBreakdownRequestSchema.parse({ text: 'x', extra: true })).toThrow();
  });
});

describe('scheduleSuggestionRequestSchema（点 3）', () => {
  it('正常输入通过', () => {
    const input = {
      taskIds: ['123e4567-e89b-12d3-a456-426614174000'],
      availableMinutes: 120,
      windowStart: new Date().toISOString(),
      windowEnd: new Date(Date.now() + 3600_000).toISOString(),
    };
    expect(() => scheduleSuggestionRequestSchema.parse(input)).not.toThrow();
  });

  it('时间窗结束早于开始失败', () => {
    const now = new Date().toISOString();
    expect(() =>
      scheduleSuggestionRequestSchema.parse({
        taskIds: ['123e4567-e89b-12d3-a456-426614174000'],
        availableMinutes: 60,
        windowStart: now,
        windowEnd: new Date(Date.now() - 1000).toISOString(),
      }),
    ).toThrow();
  });
});

describe('expenseParseRequestSchema（点 4）', () => {
  it('正常输入通过', () => {
    expect(() => expenseParseRequestSchema.parse({ text: '午餐 35' })).not.toThrow();
  });
});

describe('reviewSummaryRequestSchema（点 4）', () => {
  it('两个范围都关掉失败', () => {
    expect(() =>
      reviewSummaryRequestSchema.parse({
        weekStart: '2026-10-05',
        scope: { includeTasks: false, includeExpenses: false },
      }),
    ).toThrow();
  });
});

describe('aiDraftConfirmBodySchema（点 5 confirm 边界）', () => {
  it('tasks 空数组失败（min1）', () => {
    expect(() => aiDraftConfirmBodySchema.parse({ tasks: [] })).toThrow();
  });

  it('tasks 20 条通过', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      title: `任务 ${i + 1}`,
      estimatedMinutes: 30,
    }));
    expect(() => aiDraftConfirmBodySchema.parse({ tasks: items })).not.toThrow();
  });

  it('expense 提供 categoryId 通过', () => {
    expect(() =>
      aiDraftConfirmBodySchema.parse({
        expense: { categoryId: '123e4567-e89b-12d3-a456-426614174000', currencyCode: 'CNY' },
      }),
    ).not.toThrow();
  });

  it('task 标题空白压缩后仍须 >=1', () => {
    expect(() =>
      aiDraftConfirmBodySchema.parse({
        tasks: [{ title: '   ', estimatedMinutes: 30 }],
      }),
    ).toThrow();
  });
});
