// @vitest-environment node
/**
 * AI 草稿确认 / 取消生命周期（PD-020 点 3、点 9、点 19）。
 *
 * ## 为什么这里能直调用例（「server-only 阻断」的反证）
 *
 * `confirm-ai-draft.ts` 的 import 链只有 zod + 领域接口 + 类型（见总监三审实查：
 * `src/modules/ai` 与 `composition-root.ts` 对 `server-only` grep 零命中），因此
 * 与 `notifications` 假仓储直调范式同形：注入内存版 `AiDraftRepository` + 既有
 * `createFakeUserRepository`，在不启动 Next.js、不连 PostgreSQL 的前提下把
 * 并发、终态、过期、归属校验逐条跑成可执行证据。
 *
 * ## 假仓储为什么能复现「并发恰一次」
 *
 * 真实实现靠 `UPDATE ... WHERE status = from` 把「判定 + 写入」合成一条原子语句。
 * 这里的 `transitionStatus` 刻意**不含 await**：`async` 函数体在首个 `await` 前
 * 同步执行，于是「读状态 → 比较 → 写状态」在事件循环里不可被打断，与条件 UPDATE
 * 同语义。这不是「用数组假装在测并发」——它测的正是用例层对 `null` 的处置
 * （转 409 而非重写），而这恰是真实实现里由 SQL 原子性保证、由用例消费的那一半。
 *
 * 覆盖：点 9（并发恰一次 / 重复取消幂等失败）、点 3（排程草稿 source='suggested'
 * 与用户时区落点）、点 19 后端护栏（终态 409、过期 409、失败 422/409、越权 404、
 * 写入失败回滚）。
 */
import { describe, expect, it } from 'vitest';

import { ConfirmAiDraftUseCase } from '../../../src/modules/ai/application/confirm-ai-draft.ts';
import type {
  AiDraft,
  AiDraftStatus,
  AiDraftType,
  NewAiDraft,
} from '../../../src/modules/ai/domain/ai-draft.ts';
import type { AiDraftRepository } from '../../../src/modules/ai/domain/ai-draft-repository.ts';
import type { ManageExpenseUseCase } from '../../../src/modules/expenses/application/manage-expense.ts';
import type { ManageScheduleBlockUseCase } from '../../../src/modules/scheduling/application/manage-scheduling.ts';
import type { ManageTaskUseCase } from '../../../src/modules/tasks/application/manage-task.ts';
import {
  ConflictError,
  InvariantError,
  NotFoundError,
  ValidationError,
} from '../../../src/shared/errors/app-error.ts';
import type { Logger } from '../../../src/shared/telemetry/logger.ts';
import { createFakeDatabase, createFakeUserRepository } from '../../helpers/fake-repositories.ts';

/** 固定时钟：让「过期」与「未过期」变成两个确定的入参，而不是跑得出来跑不出来的差别。 */
const FIXED_ISO = '2026-10-06T00:00:00.000Z';
const FIXED_NOW = new Date(FIXED_ISO);
/** 未过期草稿的到期时刻（晚于固定时钟）。 */
const FUTURE_EXPIRY = '2026-10-07T00:00:00.000Z';

/** 排程结果里的合法 UUID（`scheduleSuggestionResultSchema.taskId` 要求 uuid）。 */
const TASK_UUID = '123e4567-e89b-12d3-a456-426614174000';

/** 捕获到的任务写入调用（点 3 断言 `source`／C1 断言编辑落库／并发断言「只写一次」）。 */
interface CapturedTaskCreate {
  readonly userId: string;
  readonly input: {
    readonly source: string;
    readonly title: string;
    readonly estimatedMinutes: number | null;
  };
}

/** 捕获到的排程写入调用（点 3 字段级断言）。 */
interface CapturedScheduleCreate {
  readonly userId: string;
  readonly input: {
    readonly taskId: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly timezone: string;
    readonly source: string;
  };
}

/** 捕获到的开销写入调用。 */
interface CapturedExpenseCreate {
  readonly userId: string;
  readonly input: {
    readonly categoryId: string;
    readonly amountMinor: string;
    readonly source: string;
  };
}

/** 什么都不做的 logger：本文件断言的是状态与调用，不是日志形状。 */
function createNoopLogger(): Logger {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: (): Logger => createNoopLogger(),
  };
}

/**
 * 内存版草稿仓储（`AiDraftRepository` 三方法）。
 *
 * 与真实实现刻意一致的两点：查询强制 `userId` 作用域（非本人 id 查不到），
 * `transitionStatus` 是条件迁移（状态不等于 `from` 即返回 `null`）。
 */
function createFakeDraftRepository(): {
  readonly repo: AiDraftRepository;
  readonly drafts: AiDraft[];
} {
  const drafts: AiDraft[] = [];
  let sequence = 0;

  return {
    drafts,
    repo: {
      async create(input: NewAiDraft): Promise<AiDraft> {
        sequence += 1;
        const created: AiDraft = {
          id: `draft-${String(sequence).padStart(4, '0')}`,
          userId: input.userId,
          draftType: input.draftType,
          inputHash: input.inputHash,
          sanitizedInput: input.sanitizedInput,
          resultJson: input.resultJson,
          status: input.status,
          provider: input.provider,
          model: input.model,
          expiresAt: input.expiresAt.toISOString(),
          errorCode: input.errorCode,
          createdAt: FIXED_ISO,
          updatedAt: FIXED_ISO,
        };
        drafts.push(created);
        return created;
      },

      async findById(userId: string, draftId: string): Promise<AiDraft | null> {
        return drafts.find((draft) => draft.id === draftId && draft.userId === userId) ?? null;
      },

      // 同步读改、无 await —— 见文件头「假仓储为什么能复现并发恰一次」。
      async transitionStatus(
        userId: string,
        draftId: string,
        from: AiDraftStatus,
        to: AiDraftStatus,
      ): Promise<AiDraft | null> {
        const index = drafts.findIndex((draft) => draft.id === draftId && draft.userId === userId);
        const current = drafts[index];
        if (current === undefined || current.status !== from) {
          return null;
        }
        const updated: AiDraft = { ...current, status: to, updatedAt: FIXED_ISO };
        drafts[index] = updated;
        return updated;
      },
    },
  };
}

/** 直接在假仓储里种一条草稿（含终态 / 过期 / 缺省合法 result_json）。 */
function seedDraft(
  drafts: AiDraft[],
  overrides: {
    readonly userId: string;
    readonly draftType?: AiDraftType;
    readonly status?: AiDraftStatus;
    readonly resultJson?: unknown;
    readonly expiresAt?: string;
  },
): AiDraft {
  const status = overrides.status ?? 'pending';
  const draft: AiDraft = {
    id: `seed-${String(drafts.length + 1).padStart(4, '0')}`,
    userId: overrides.userId,
    draftType: overrides.draftType ?? 'review_summary',
    inputHash: 'hash',
    sanitizedInput: 'sanitized',
    resultJson: overrides.resultJson ?? { summary: { highlights: [], suggestions: [] } },
    status,
    provider: 'mock',
    model: 'mock-model',
    expiresAt: overrides.expiresAt ?? FUTURE_EXPIRY,
    errorCode: status === 'failed' ? 'AI_RESPONSE_INVALID' : null,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  };
  drafts.push(draft);
  return draft;
}

async function setup(options: { readonly failTaskCreate?: boolean } = {}) {
  const database = createFakeDatabase();
  const users = createFakeUserRepository(database);
  const { user } = await users.ensureLocalUser([]);
  const { repo: drafts, drafts: draftRows } = createFakeDraftRepository();

  const taskCalls: CapturedTaskCreate[] = [];
  const scheduleCalls: CapturedScheduleCreate[] = [];
  const expenseCalls: CapturedExpenseCreate[] = [];

  // 三个既有业务用例只在本文件用到 `create`——用最小假实现替换，其余方法不进调用面。
  const tasks = {
    async create(userId: string, input: CapturedTaskCreate['input']) {
      if (options.failTaskCreate === true) {
        throw new InvariantError({ message: '模拟任务写入失败' });
      }
      taskCalls.push({ userId, input });
      return { id: `task-${String(taskCalls.length).padStart(4, '0')}` };
    },
  } as unknown as ManageTaskUseCase;

  const schedules = {
    async create(userId: string, input: CapturedScheduleCreate['input']) {
      scheduleCalls.push({ userId, input });
      return { block: { id: `block-${String(scheduleCalls.length).padStart(4, '0')}` } };
    },
  } as unknown as ManageScheduleBlockUseCase;

  const expenses = {
    async create(userId: string, input: CapturedExpenseCreate['input']) {
      expenseCalls.push({ userId, input });
      return { id: `expense-${String(expenseCalls.length).padStart(4, '0')}` };
    },
  } as unknown as ManageExpenseUseCase;

  const useCase = new ConfirmAiDraftUseCase({
    drafts,
    tasks,
    schedules,
    expenses,
    users,
    logger: createNoopLogger(),
    now: () => FIXED_NOW,
  });

  return { useCase, userId: user.id, draftRows, taskCalls, scheduleCalls, expenseCalls };
}

describe('点 9 · 并发与幂等', () => {
  it('并发确认同一草稿：仅一次写入业务实体，另一次 409', async () => {
    const { useCase, userId, draftRows, taskCalls } = await setup();
    const draft = seedDraft(draftRows, {
      userId,
      draftType: 'task_breakdown',
      resultJson: { suggestions: [{ title: '写周报', estimatedMinutes: 30 }] },
    });

    const results = await Promise.allSettled([
      useCase.confirm(userId, draft.id, {}),
      useCase.confirm(userId, draft.id, {}),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled, '并发确认应当恰有一次成功').toHaveLength(1);
    expect(rejected, '另一次必须 409 而不是二次写入').toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    // 「一次性消费」的实证：业务实体只被创建一次，而不是两次。
    expect(taskCalls).toHaveLength(1);
    expect(draftRows.find((row) => row.id === draft.id)?.status).toBe('confirmed');
  });

  it('重复取消同一草稿：第一次成功，第二次 409（终态不可再迁移）', async () => {
    const { useCase, userId, draftRows } = await setup();
    const draft = seedDraft(draftRows, { userId });

    const cancelled = await useCase.cancel(userId, draft.id);
    expect(cancelled.status).toBe('cancelled');

    await expect(useCase.cancel(userId, draft.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('点 6：取消 pending → cancelled，且不写任何业务实体', async () => {
    const { useCase, userId, draftRows, taskCalls, scheduleCalls, expenseCalls } = await setup();
    const draft = seedDraft(draftRows, {
      userId,
      draftType: 'task_breakdown',
      resultJson: { suggestions: [{ title: '写周报', estimatedMinutes: 30 }] },
    });

    const cancelled = await useCase.cancel(userId, draft.id);

    expect(cancelled.status).toBe('cancelled');
    expect(taskCalls).toHaveLength(0);
    expect(scheduleCalls).toHaveLength(0);
    expect(expenseCalls).toHaveLength(0);
  });
});

describe('点 3 · 排程草稿的字段级落点', () => {
  it('以 source=suggested 与用户时区写入既有排程块，createdIds 为块 id', async () => {
    const { useCase, userId, draftRows, scheduleCalls } = await setup();
    const draft = seedDraft(draftRows, {
      userId,
      draftType: 'schedule_suggestion',
      resultJson: {
        suggestions: [
          {
            taskId: TASK_UUID,
            blockStart: '2026-10-06T01:00:00.000Z',
            blockEnd: '2026-10-06T02:00:00.000Z',
            reason: '上午精力最好',
          },
        ],
      },
    });

    const result = await useCase.confirm(userId, draft.id, {});

    expect(result.createdIds).toEqual(['block-0001']);
    expect(scheduleCalls).toHaveLength(1);
    const call = scheduleCalls[0];
    expect(call?.input.source, 'AI 确认写入必须标 source=suggested').toBe('suggested');
    // 时区取自用户设置（`Asia/Shanghai`），不采信模型输出。
    expect(call?.input.timezone).toBe('Asia/Shanghai');
    expect(call?.input.taskId).toBe(TASK_UUID);
    expect(call?.input.startsAt).toBe('2026-10-06T01:00:00.000Z');
    expect(call?.input.endsAt).toBe('2026-10-06T02:00:00.000Z');
  });

  it('任务拆解确认标 source=ai（来源在写入那刻不丢失）', async () => {
    const { useCase, userId, draftRows, taskCalls } = await setup();
    const draft = seedDraft(draftRows, {
      userId,
      draftType: 'task_breakdown',
      resultJson: { suggestions: [{ title: '写周报', estimatedMinutes: 30 }] },
    });

    await useCase.confirm(userId, draft.id, {});

    expect(taskCalls[0]?.input.source).toBe('ai');
  });
});

describe('点 19 · 终态与过期（confirm/cancel 一律 409，不静默降级）', () => {
  it.each([
    ['confirmed', 'confirmed'],
    ['cancelled', 'cancelled'],
    ['expired', 'expired'],
  ] as const)('confirm 对终态草稿（%s）返 409', async (_label, status) => {
    const { useCase, userId, draftRows } = await setup();
    const draft = seedDraft(draftRows, { userId, status });

    await expect(useCase.confirm(userId, draft.id, {})).rejects.toBeInstanceOf(ConflictError);
  });

  it('confirm 对已过期但状态仍为 pending 的草稿返 409，message 明确「草稿已过期」', async () => {
    const { useCase, userId, draftRows } = await setup();
    const draft = seedDraft(draftRows, {
      userId,
      status: 'pending',
      expiresAt: '2026-10-05T23:59:59.000Z', // 早于固定时钟
    });

    await expect(useCase.confirm(userId, draft.id, {})).rejects.toMatchObject({
      code: 'CONFLICT',
      message: '草稿已过期',
    });
  });

  it('confirm 对失败草稿返 422（VALIDATION_ERROR，不是 409）', async () => {
    const { useCase, userId, draftRows } = await setup();
    const draft = seedDraft(draftRows, { userId, status: 'failed' });

    await expect(useCase.confirm(userId, draft.id, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    ['confirmed', 'confirmed'],
    ['cancelled', 'cancelled'],
    ['failed', 'failed'],
  ] as const)('cancel 对终态草稿（%s）返 409', async (_label, status) => {
    const { useCase, userId, draftRows } = await setup();
    const draft = seedDraft(draftRows, { userId, status });

    await expect(useCase.cancel(userId, draft.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('cancel 对已过期草稿返 409，message 明确「草稿已过期」', async () => {
    const { useCase, userId, draftRows } = await setup();
    const draft = seedDraft(draftRows, {
      userId,
      status: 'pending',
      expiresAt: '2026-10-05T23:59:59.000Z',
    });

    await expect(useCase.cancel(userId, draft.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: '草稿已过期',
    });
  });
});

describe('点 19 · 归属（非本人草稿一律 404，不泄露存在性）', () => {
  it('confirm 他人草稿 → 404 NOT_FOUND', async () => {
    const { useCase, userId, draftRows } = await setup();
    const foreign = seedDraft(draftRows, { userId: 'user-9999' });

    await expect(useCase.confirm(userId, foreign.id, {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it('cancel 他人草稿 → 404 NOT_FOUND', async () => {
    const { useCase, userId, draftRows } = await setup();
    const foreign = seedDraft(draftRows, { userId: 'user-9999' });

    await expect(useCase.cancel(userId, foreign.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('确认不存在的草稿 → 404 NOT_FOUND', async () => {
    const { useCase, userId } = await setup();

    await expect(useCase.confirm(userId, 'draft-missing', {})).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('点 19 · 写入失败回滚（草稿回到 pending，可修复后重试）', () => {
  it('业务写入失败时草稿回滚为 pending，并向上抛原始错误', async () => {
    const { useCase, userId, draftRows } = await setup({ failTaskCreate: true });
    const draft = seedDraft(draftRows, {
      userId,
      draftType: 'task_breakdown',
      resultJson: { suggestions: [{ title: '写周报', estimatedMinutes: 30 }] },
    });

    await expect(useCase.confirm(userId, draft.id, {})).rejects.toBeInstanceOf(InvariantError);

    // 回滚的实证：既没拿到实体，也不该丢掉重试机会。
    expect(draftRows.find((row) => row.id === draft.id)?.status).toBe('pending');
  });
});

describe('点 19 护栏 3 · C1 编辑落库（《UI 规范》§5 C1「可编辑、可移除单项」）', () => {
  /** 三条建议的拆解草稿（用于验证「移除单项」只落剩下的）。 */
  function seedThreeSuggestions(draftRows: AiDraft[], userId: string): AiDraft {
    return seedDraft(draftRows, {
      userId,
      draftType: 'task_breakdown',
      resultJson: {
        suggestions: [
          { title: '草稿标题一', estimatedMinutes: 10 },
          { title: '草稿标题二', estimatedMinutes: 20 },
          { title: '草稿标题三', estimatedMinutes: 30 },
        ],
      },
    });
  }

  it('用户改过标题与分钟时，落库用的是用户值而不是草稿原值', async () => {
    const { useCase, userId, draftRows, taskCalls } = await setup();
    const draft = seedThreeSuggestions(draftRows, userId);

    await useCase.confirm(userId, draft.id, {
      tasks: [{ title: '改写后的标题', estimatedMinutes: 45 }],
    });

    expect(taskCalls).toHaveLength(1);
    expect(taskCalls[0]?.input.title).toBe('改写后的标题');
    expect(taskCalls[0]?.input.estimatedMinutes).toBe(45);
  });

  it('不带 tasks 时回落草稿原值（用户没改）', async () => {
    const { useCase, userId, draftRows, taskCalls } = await setup();
    const draft = seedThreeSuggestions(draftRows, userId);

    await useCase.confirm(userId, draft.id, {});

    expect(taskCalls).toHaveLength(3);
    expect(taskCalls.map((call) => call.input.title)).toEqual([
      '草稿标题一',
      '草稿标题二',
      '草稿标题三',
    ]);
    expect(taskCalls.map((call) => call.input.estimatedMinutes)).toEqual([10, 20, 30]);
  });

  it('移除单项后只落剩下的（传几条就写几条）', async () => {
    const { useCase, userId, draftRows, taskCalls } = await setup();
    const draft = seedThreeSuggestions(draftRows, userId);

    const result = await useCase.confirm(userId, draft.id, {
      tasks: [{ title: '只留这一条' }],
    });

    expect(taskCalls).toHaveLength(1);
    expect(taskCalls[0]?.input.title).toBe('只留这一条');
    // 未给时长时写 null，而不是臆造一个默认值。
    expect(taskCalls[0]?.input.estimatedMinutes).toBeNull();
    expect(result.createdIds).toHaveLength(1);
  });
});
