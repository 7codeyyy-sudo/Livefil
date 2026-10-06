/**
 * 确认请求体边界（PD-020 点 19 · RD-009 回执 §七 护栏 4）。
 *
 * 护栏原文：「确认体边界：`tasks: []` 返 400；`title` 超 `TASK_TITLE_MAX_LENGTH`
 * 或空串 400；不带 `tasks` 按草稿原值写（回落）」。
 *
 * 这里只测**校验层**（`aiDraftConfirmBodySchema`）——它是 400 与「放行」的分界线。
 * 「不带 `tasks` 时确实回落草稿原值」的写入行为在后端直调用例里断言
 * （`tests/integration/ai/draft-lifecycle.test.ts` 的 C1 组）。
 *
 * 为什么用真实的 schema 而不是手搓断言：`PATCH/POST` 的实际链路是
 * 「Zod 校验 → 用例」，绕过校验等于测了一个生产上不存在的输入面。
 */
import { describe, expect, it } from 'vitest';

import { aiDraftConfirmBodySchema } from '../../../src/modules/ai/application/ai-draft-dto.ts';
import { TASK_TITLE_MAX_LENGTH } from '../../../src/modules/tasks/domain/task.ts';

/** 一个合法 uuid（`expense.categoryId` 要求）。 */
const CATEGORY_UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('护栏 4 · tasks 分组边界', () => {
  it('不带 tasks → 通过（缺省走回落）', () => {
    expect(aiDraftConfirmBodySchema.safeParse({}).success).toBe(true);
  });

  it('tasks: [] → 400（空数组是「全删了再确认」，不放行）', () => {
    const result = aiDraftConfirmBodySchema.safeParse({ tasks: [] });

    expect(result.success).toBe(false);
  });

  it('标题为空串 → 400', () => {
    expect(aiDraftConfirmBodySchema.safeParse({ tasks: [{ title: '   ' }] }).success).toBe(false);
  });

  it('标题超 TASK_TITLE_MAX_LENGTH → 400', () => {
    const tooLong = 'a'.repeat(TASK_TITLE_MAX_LENGTH + 1);

    expect(aiDraftConfirmBodySchema.safeParse({ tasks: [{ title: tooLong }] }).success).toBe(false);
  });

  it('标题恰为上限 → 通过（边界不多不少）', () => {
    const exact = 'a'.repeat(TASK_TITLE_MAX_LENGTH);

    expect(aiDraftConfirmBodySchema.safeParse({ tasks: [{ title: exact }] }).success).toBe(true);
  });

  it('estimatedMinutes 允许缺省与 null（移除单项后不写时长）', () => {
    expect(aiDraftConfirmBodySchema.safeParse({ tasks: [{ title: '写周报' }] }).success).toBe(true);
    expect(
      aiDraftConfirmBodySchema.safeParse({ tasks: [{ title: '写周报', estimatedMinutes: null }] })
        .success,
    ).toBe(true);
  });

  it('estimatedMinutes 为 0 或负数 → 400', () => {
    expect(
      aiDraftConfirmBodySchema.safeParse({ tasks: [{ title: '写周报', estimatedMinutes: 0 }] })
        .success,
    ).toBe(false);
  });

  it('任务行含多余字段 → 400（strict 不放行「多发一个字段」）', () => {
    expect(
      aiDraftConfirmBodySchema.safeParse({ tasks: [{ title: '写周报', goalId: 'g1' }] }).success,
    ).toBe(false);
  });

  it('超过 20 条任务行 → 400', () => {
    const many = Array.from({ length: 21 }, (_unused, index) => ({
      title: `任务 ${String(index)}`,
    }));

    expect(aiDraftConfirmBodySchema.safeParse({ tasks: many }).success).toBe(false);
  });
});

describe('护栏 4 · expense 分组边界', () => {
  it('categoryId 必须为 uuid → 非 uuid 400', () => {
    expect(
      aiDraftConfirmBodySchema.safeParse({ expense: { categoryId: 'not-a-uuid' } }).success,
    ).toBe(false);
  });

  it('只给 categoryId（其余可省）→ 通过', () => {
    expect(
      aiDraftConfirmBodySchema.safeParse({ expense: { categoryId: CATEGORY_UUID } }).success,
    ).toBe(true);
  });

  it('amountMinor 为 0 → 400（金额必须为正整数分）', () => {
    expect(
      aiDraftConfirmBodySchema.safeParse({ expense: { categoryId: CATEGORY_UUID, amountMinor: 0 } })
        .success,
    ).toBe(false);
  });

  it('currencyCode 小写 → 通过并归一为大写', () => {
    const result = aiDraftConfirmBodySchema.safeParse({
      expense: { categoryId: CATEGORY_UUID, currencyCode: 'cny' },
    });

    expect(result.success).toBe(true);
    expect(result.success ? result.data.expense?.currencyCode : null).toBe('CNY');
  });

  it('expense 含多余字段 → 400', () => {
    expect(
      aiDraftConfirmBodySchema.safeParse({ expense: { categoryId: CATEGORY_UUID, source: 'ai' } })
        .success,
    ).toBe(false);
  });
});

describe('护栏 4 · 顶层 strict', () => {
  it('未知顶层字段 → 400', () => {
    expect(aiDraftConfirmBodySchema.safeParse({ draftId: 'x' }).success).toBe(false);
  });
});
