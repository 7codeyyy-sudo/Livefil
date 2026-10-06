// @vitest-environment node
/**
 * AI 用量、额度窗口与限流（PD-020 点 6、点 19）。
 *
 * ## 覆盖的三件事
 *
 * 1. **额度窗口＝用户时区自然月**（RD-006 §1.5）：`GET /ai/usage` 的 `periodStart`
 *    必须在 `Asia/Shanghai` 的月初边界上切换，而不是按 UTC 月切——否则用户在
 *    「自己以为的本月」头 8 小时里看到的剩余额度与实际拦截点对不上。
 * 2. **月限两枚 + 速率一枚**（`assertWithinAiQuota`）：次数、成本、每分钟各自触顶
 *    都返 429，且**不发上游请求**（预检在 `provider.complete` 之前）。
 * 3. **Mock 计 skipped 不占额度**（DB §4.13.2）：同一次调用在 mock 与真实 provider
 *    下入账状态不同，只有 `success` 进 `summarize`。
 *
 * 全部直调用例（`GetAiUsageUseCase` / `InvokeAiProviderUseCase`），不启动 Next.js、
 * 不连 PostgreSQL——依赖（时钟、仓储、provider、上限）全部注入，边界因此完全确定。
 */
import { describe, expect, it } from 'vitest';

import { GetAiUsageUseCase } from '../../../src/modules/ai/application/get-ai-usage.ts';
import { InvokeAiProviderUseCase } from '../../../src/modules/ai/application/invoke-ai-provider.ts';
import { resolveAiBillingPeriod } from '../../../src/modules/ai/application/ai-billing-period.ts';
import { MOCK_PROVIDER_NAME } from '../../../src/modules/ai/domain/ai-provider.ts';
import type { AiCompletionResult, AiProvider } from '../../../src/modules/ai/domain/ai-provider.ts';
import type { AiQuotaLimits } from '../../../src/modules/ai/domain/ai-policy.ts';
import type { AiUsageSummary, NewAiUsageRecord } from '../../../src/modules/ai/domain/ai-usage.ts';
import type { AiUsageRepository } from '../../../src/modules/ai/domain/ai-usage-repository.ts';
import {
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '../../../src/shared/errors/app-error.ts';
import type { Logger } from '../../../src/shared/telemetry/logger.ts';
import { createFakeDatabase, createFakeUserRepository } from '../../helpers/fake-repositories.ts';

/** 记账行 + 它的落库时刻（假仓储靠它复现时间窗聚合）。 */
interface StoredUsage extends NewAiUsageRecord {
  readonly at: Date;
}

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
 * 内存版用量仓储。
 *
 * `summarize` **只统计 `status='success'`**（与真实实现的 WHERE 同语义）：mock 行
 * 与失败行都不消耗额度。区间取闭，与端口注释一致。
 */
function createFakeUsageRepository(now: () => Date): {
  readonly repo: AiUsageRepository;
  readonly rows: StoredUsage[];
} {
  const rows: StoredUsage[] = [];
  return {
    rows,
    repo: {
      async record(input: NewAiUsageRecord): Promise<void> {
        rows.push({ ...input, at: now() });
      },
      async summarize(userId: string, from: Date, to: Date): Promise<AiUsageSummary> {
        const scoped = rows.filter(
          (row) =>
            row.userId === userId &&
            row.status === 'success' &&
            row.at.getTime() >= from.getTime() &&
            row.at.getTime() <= to.getTime(),
        );
        return {
          callCount: scoped.length,
          costMinor: scoped.reduce((sum, row) => sum + row.estimatedCostMinor, 0),
        };
      },
    },
  };
}

/** 种一条已发生的用量行（默认成功、零成本）。 */
function seedUsage(
  rows: StoredUsage[],
  userId: string,
  overrides: Partial<Omit<StoredUsage, 'userId'>> = {},
): void {
  rows.push({
    userId,
    provider: overrides.provider ?? 'deepseek',
    model: overrides.model ?? 'deepseek-chat',
    requestType: overrides.requestType ?? 'task_breakdown',
    inputTokens: overrides.inputTokens ?? null,
    outputTokens: overrides.outputTokens ?? null,
    estimatedCostMinor: overrides.estimatedCostMinor ?? 0,
    status: overrides.status ?? 'success',
    at: overrides.at ?? new Date('2026-10-06T00:00:00.000Z'),
  });
}

/** 月调用 3 次 / 月成本 100 分 / 每分钟 2 次——小上限让触顶成为可直接构造的入参。 */
const LIMITS: AiQuotaLimits = Object.freeze({
  monthlyCallLimit: 3,
  monthlyCostLimitMinor: 100,
  perMinuteLimit: 2,
});

/** 一次可用的调用入参模板（默认已开启 AI 且已同意）。 */
function invokeInput(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    aiEnabled: true,
    aiDataConsent: true,
    timezone: 'Asia/Shanghai',
    requestType: 'task_breakdown' as const,
    systemPrompt: 'system',
    userContent: '脱敏后的内容',
    maxOutputTokens: 256,
    ...overrides,
  };
}

/** 造一个 provider；`onCall` 用来断言「预检失败时上游根本没被调用」。 */
function createProvider(options: {
  readonly name: string;
  readonly result?: Partial<AiCompletionResult>;
  readonly onCall?: () => void;
  readonly fail?: boolean;
}): AiProvider {
  return {
    name: options.name,
    async complete(): Promise<AiCompletionResult> {
      options.onCall?.();
      if (options.fail === true) {
        throw new Error('上游炸了');
      }
      return {
        content: '{}',
        provider: options.name,
        model: `${options.name}-model`,
        inputTokens: 10,
        outputTokens: 20,
        estimatedCostMinor: 5,
        ...options.result,
      };
    },
  };
}

describe('点 6 · 额度窗口＝用户时区自然月', () => {
  it('Asia/Shanghai 用户在 UTC 月末 17:00 已进入本地次月（不按 UTC 切）', async () => {
    const now = new Date('2026-09-30T17:00:00.000Z'); // 本地 = 2026-10-01 01:00 (+08)
    const database = createFakeDatabase();
    const users = createFakeUserRepository(database);
    const { user } = await users.ensureLocalUser([]);
    const { repo: usage } = createFakeUsageRepository(() => now);

    const view = await new GetAiUsageUseCase({
      usage,
      users,
      limits: LIMITS,
      now: () => now,
    }).execute(user.id);

    expect(view.periodStart).toBe('2026-09-30T16:00:00.000Z');
    expect(view.resetAt).toBe('2026-10-31T16:00:00.000Z');
  });

  it('同一 UTC 月、本地仍属上月时窗口不误切', async () => {
    const now = new Date('2026-09-30T15:00:00.000Z'); // 本地 = 2026-09-30 23:00 (+08)
    const database = createFakeDatabase();
    const users = createFakeUserRepository(database);
    const { user } = await users.ensureLocalUser([]);
    const { repo: usage } = createFakeUsageRepository(() => now);

    const view = await new GetAiUsageUseCase({
      usage,
      users,
      limits: LIMITS,
      now: () => now,
    }).execute(user.id);

    expect(view.periodStart).toBe('2026-08-31T16:00:00.000Z');
    expect(view.resetAt).toBe('2026-09-30T16:00:00.000Z');
  });

  it('跨 UTC 日不改判定：拿同一个瞬时反复求周期，结果一致', () => {
    const now = new Date('2026-09-30T17:00:00.000Z');
    const first = resolveAiBillingPeriod(now, 'Asia/Shanghai');
    const second = resolveAiBillingPeriod(new Date('2026-09-30T17:00:00.000Z'), 'Asia/Shanghai');

    expect(first.start.toISOString()).toBe(second.start.toISOString());
    expect(first.resetAt.toISOString()).toBe(second.resetAt.toISOString());
  });

  it('剩余额度不呈现负数（已超限时给 0）', async () => {
    const now = new Date('2026-10-06T00:00:00.000Z');
    const database = createFakeDatabase();
    const users = createFakeUserRepository(database);
    const { user } = await users.ensureLocalUser([]);
    const { repo: usage, rows } = createFakeUsageRepository(() => now);
    for (let index = 0; index < 5; index += 1) {
      seedUsage(rows, user.id, { estimatedCostMinor: 50, at: now });
    }

    const view = await new GetAiUsageUseCase({
      usage,
      users,
      limits: LIMITS,
      now: () => now,
    }).execute(user.id);

    expect(view.callCount).toBe(5);
    expect(view.costMinor).toBe(250);
    expect(view.remainingCalls).toBe(0);
    expect(view.remainingCostMinor).toBe(0);
  });

  it('用户不存在 → 404', async () => {
    const now = new Date('2026-10-06T00:00:00.000Z');
    const database = createFakeDatabase();
    const users = createFakeUserRepository(database);
    const { repo: usage } = createFakeUsageRepository(() => now);

    await expect(
      new GetAiUsageUseCase({ usage, users, limits: LIMITS, now: () => now }).execute(
        'user-missing',
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('点 6 · Mock 计 skipped 不占额度', () => {
  it('mock 调用记 skipped，连续调用不受月限影响', async () => {
    const now = new Date('2026-10-06T00:00:00.000Z');
    const database = createFakeDatabase();
    const users = createFakeUserRepository(database);
    const { user } = await users.ensureLocalUser([]);
    const { repo: usage, rows } = createFakeUsageRepository(() => now);
    const provider = createProvider({ name: MOCK_PROVIDER_NAME });
    const useCase = new InvokeAiProviderUseCase({
      provider,
      usage,
      logger: createNoopLogger(),
      now: () => now,
      timeoutMs: 1000,
      limits: { ...LIMITS, monthlyCallLimit: 1 },
      model: 'configured-model',
    });

    // 上限为 1：若 mock 占额度，第二次就会 429。
    await useCase.execute(invokeInput(user.id));
    await useCase.execute(invokeInput(user.id));

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'skipped')).toBe(true);
  });

  it('真实 provider 成功记 success（额度口径的分叉点）', async () => {
    const now = new Date('2026-10-06T00:00:00.000Z');
    const database = createFakeDatabase();
    const users = createFakeUserRepository(database);
    const { user } = await users.ensureLocalUser([]);
    const { repo: usage, rows } = createFakeUsageRepository(() => now);
    const useCase = new InvokeAiProviderUseCase({
      provider: createProvider({ name: 'deepseek' }),
      usage,
      logger: createNoopLogger(),
      now: () => now,
      timeoutMs: 1000,
      limits: LIMITS,
      model: 'deepseek-chat',
    });

    await useCase.execute(invokeInput(user.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('success');
    expect(rows[0]?.estimatedCostMinor).toBe(5);
  });
});

describe('点 6 / 点 19 · 月限两枚与速率限流（429 且不打上游）', () => {
  it('月调用次数触顶 → 429，且 provider 未被调用', async () => {
    const now = new Date('2026-10-06T00:00:00.000Z');
    const database = createFakeDatabase();
    const users = createFakeUserRepository(database);
    const { user } = await users.ensureLocalUser([]);
    const { repo: usage, rows } = createFakeUsageRepository(() => now);
    for (let index = 0; index < LIMITS.monthlyCallLimit; index += 1) {
      seedUsage(rows, user.id, { at: new Date('2026-10-05T00:00:00.000Z') });
    }
    let called = 0;
    const useCase = new InvokeAiProviderUseCase({
      provider: createProvider({ name: 'deepseek', onCall: () => (called += 1) }),
      usage,
      logger: createNoopLogger(),
      now: () => now,
      timeoutMs: 1000,
      limits: LIMITS,
      model: 'deepseek-chat',
    });

    await expect(useCase.execute(invokeInput(user.id))).rejects.toBeInstanceOf(RateLimitError);
    expect(called, '预检必须在发请求之前').toBe(0);
  });

  it('月成本触顶 → 429（次数未满，成本先满）', async () => {
    const now = new Date('2026-10-06T00:00:00.000Z');
    const database = createFakeDatabase();
    const users = createFakeUserRepository(database);
    const { user } = await users.ensureLocalUser([]);
    const { repo: usage, rows } = createFakeUsageRepository(() => now);
    seedUsage(rows, user.id, {
      estimatedCostMinor: LIMITS.monthlyCostLimitMinor,
      at: new Date('2026-10-05T00:00:00.000Z'),
    });
    let called = 0;
    const useCase = new InvokeAiProviderUseCase({
      provider: createProvider({ name: 'deepseek', onCall: () => (called += 1) }),
      usage,
      logger: createNoopLogger(),
      now: () => now,
      timeoutMs: 1000,
      limits: LIMITS,
      model: 'deepseek-chat',
    });

    await expect(useCase.execute(invokeInput(user.id))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: '本月 AI 调用成本已达上限',
    });
    expect(called).toBe(0);
  });

  it('每分钟触顶 → 429（滚动 60 秒）。不动用「自然分钟」凑数', async () => {
    const now = new Date('2026-10-06T00:00:00.000Z');
    const database = createFakeDatabase();
    const users = createFakeUserRepository(database);
    const { user } = await users.ensureLocalUser([]);
    const { repo: usage, rows } = createFakeUsageRepository(() => now);
    // 30 秒前的两次调用：在月窗内，也在滚动 60 秒窗内。
    for (let index = 0; index < LIMITS.perMinuteLimit; index += 1) {
      seedUsage(rows, user.id, { at: new Date(now.getTime() - 30_000) });
    }
    let called = 0;
    const useCase = new InvokeAiProviderUseCase({
      provider: createProvider({ name: 'deepseek', onCall: () => (called += 1) }),
      usage,
      logger: createNoopLogger(),
      now: () => now,
      timeoutMs: 1000,
      limits: LIMITS,
      model: 'deepseek-chat',
    });

    await expect(useCase.execute(invokeInput(user.id))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'AI 调用过于频繁，请稍后重试',
    });
    expect(called).toBe(0);
  });

  it('60 秒窗口外的旧调用不参与速率判定', async () => {
    const now = new Date('2026-10-06T00:00:00.000Z');
    const database = createFakeDatabase();
    const users = createFakeUserRepository(database);
    const { user } = await users.ensureLocalUser([]);
    const { repo: usage, rows } = createFakeUsageRepository(() => now);
    // 61 秒前：已滑出滚动窗口，因此速率不拦（月限也未触顶）。
    for (let index = 0; index < LIMITS.perMinuteLimit; index += 1) {
      seedUsage(rows, user.id, { at: new Date(now.getTime() - 61_000) });
    }
    const useCase = new InvokeAiProviderUseCase({
      provider: createProvider({ name: 'deepseek' }),
      usage,
      logger: createNoopLogger(),
      now: () => now,
      timeoutMs: 1000,
      limits: LIMITS,
      model: 'deepseek-chat',
    });

    await expect(useCase.execute(invokeInput(user.id))).resolves.toMatchObject({
      provider: 'deepseek',
    });
  });
});

describe('点 19 · 门禁与失败入账', () => {
  it('未同意数据发送 → 400 且不写任何账（无调用即无账）', async () => {
    const now = new Date('2026-10-06T00:00:00.000Z');
    const database = createFakeDatabase();
    const users = createFakeUserRepository(database);
    const { user } = await users.ensureLocalUser([]);
    const { repo: usage, rows } = createFakeUsageRepository(() => now);
    let called = 0;
    const useCase = new InvokeAiProviderUseCase({
      provider: createProvider({ name: 'deepseek', onCall: () => (called += 1) }),
      usage,
      logger: createNoopLogger(),
      now: () => now,
      timeoutMs: 1000,
      limits: LIMITS,
      model: 'deepseek-chat',
    });

    await expect(
      useCase.execute(invokeInput(user.id, { aiDataConsent: false })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(called).toBe(0);
    expect(rows).toHaveLength(0);
  });

  it('调用失败如实记 failed 并向上抛；failed 行不占额度', async () => {
    const now = new Date('2026-10-06T00:00:00.000Z');
    const database = createFakeDatabase();
    const users = createFakeUserRepository(database);
    const { user } = await users.ensureLocalUser([]);
    const { repo: usage, rows } = createFakeUsageRepository(() => now);
    const useCase = new InvokeAiProviderUseCase({
      provider: createProvider({ name: 'deepseek', fail: true }),
      usage,
      logger: createNoopLogger(),
      now: () => now,
      timeoutMs: 1000,
      limits: LIMITS,
      model: 'deepseek-chat',
    });

    await expect(useCase.execute(invokeInput(user.id))).rejects.toThrow();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    // 交叉核验：失败行不进 summarize，因此额度仍是满的。
    const view = await new GetAiUsageUseCase({
      usage,
      users,
      limits: LIMITS,
      now: () => now,
    }).execute(user.id);
    expect(view.callCount).toBe(0);
    expect(view.remainingCalls).toBe(LIMITS.monthlyCallLimit);
  });
});
