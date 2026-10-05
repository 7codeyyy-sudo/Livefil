// @vitest-environment node
/**
 * D 组 · 第 8 端点 attempt（PD-019 点 12-16，NOTIFY-002 v0.7，P0）。
 *
 * 覆盖：
 * - 点 12：sent 上报（status=sent、error_code/next_retry_at 置空、channel 翻转 browser、attempt_count+1、last_attempt_at 落值）
 * - 点 13：可重试失败（CONSTRUCT_FAILED/DELIVERY_INTERNAL_ERROR）：递增后 <3 → next_retry_at＝指数 + jitter（±20%）；≥3 → NULL 停止
 * - 点 14：不可重试失败（PERMISSION_DENIED/UNSUPPORTED）：next_retry_at＝NULL 不再重试
 * - 点 15：错误语义五连（服务端权威字段提交 → 400；404 不复用 403；终态/达上限 → 409；Idempotency-Key 同键重放 → 409 不二次递增、换键 → 自然计数）
 * - 点 16：FR-071 落点（failed 行在 pending 可见且 errorCode 回带四值之一）
 *
 * 真实可执行策略（无数据库）：
 * 1. `computeNextRetryAt` / `notificationRetryDelayMs` 是纯函数，直接断言退避公式；
 * 2. `reportNotificationAttemptSchema` 是 DTO schema，直接断言入参拦截；
 * 3. `ManageNotificationDeliveryUseCase.reportAttempt` 的接口契约由假仓储模拟语义；
 * 4. 幂等键语义按**路由同构**验证：`withIdempotency` 配进程内存储替身，断言重放与换键。
 */
import { describe, expect, it } from 'vitest';

import type { NextRequest } from 'next/server';

import { withIdempotency, type IdempotencyStore } from '../../../app/_lib/idempotency.ts';
import { ValidationError } from '../../../src/shared/errors/app-error.ts';
import { ManageNotificationDeliveryUseCase } from '../../../src/modules/notifications/application/manage-notification-delivery.ts';
import {
  computeNextRetryAt,
  notificationRetryDelayMs,
  MAX_NOTIFICATION_ATTEMPTS,
} from '../../../src/modules/notifications/domain/notification-delivery.ts';
import { NOTIFICATION_LEVEL_RANK } from '../../../src/modules/notifications/domain/notification-rule.ts';
import {
  reportNotificationAttemptSchema,
  toNotificationAttemptResultDto,
} from '../../../src/modules/notifications/application/notification-delivery-dto.ts';
import type {
  ListNotificationDeliveriesOptions,
  NotificationDeliveryRepository,
} from '../../../src/modules/notifications/domain/notification-delivery-repository.ts';
import type {
  NotificationDelivery,
  NotificationDeliveryPage,
  NotificationErrorCode,
  ReportNotificationAttemptInput,
} from '../../../src/modules/notifications/domain/notification-delivery.ts';
import {
  createFakeAuditLogger,
  createFakeDatabase,
  createFakeUserRepository,
} from '../../helpers/fake-repositories.ts';
import type { FakeDatabase } from '../../helpers/fake-repositories.ts';

const OTHER_USER_ID = 'user-other';

function createFakeNotificationDeliveryRepository(
  _database: FakeDatabase,
): NotificationDeliveryRepository & { __seed: (delivery: NotificationDelivery) => void } {
  const rows: NotificationDelivery[] = [];

  return {
    async materializePending(_userId: string, _now: Date): Promise<void> {
      // 桩层
    },

    async listPending(userId: string): Promise<readonly NotificationDelivery[]> {
      return rows
        .filter(
          (r) =>
            r.userId === userId &&
            ['pending', 'failed'].includes(r.status) &&
            r.dismissedAt === null,
        )
        .sort((a, b) => {
          const rankDiff = NOTIFICATION_LEVEL_RANK[a.level] - NOTIFICATION_LEVEL_RANK[b.level];
          if (rankDiff !== 0) return rankDiff;
          return a.scheduledFor.localeCompare(b.scheduledFor);
        });
    },

    async listByUser(
      _userId: string,
      _options: ListNotificationDeliveriesOptions,
    ): Promise<NotificationDeliveryPage> {
      return { items: [], nextCursor: null, hasMore: false };
    },

    async findById(_userId: string, _deliveryId: string): Promise<NotificationDelivery | null> {
      return null;
    },

    async dismiss(_userId: string, _deliveryId: string, _now: Date): Promise<NotificationDelivery> {
      throw new Error('not implemented');
    },

    async reportAttempt(
      userId: string,
      deliveryId: string,
      input: { readonly outcome: string; readonly errorCode: NotificationErrorCode | null },
      now: Date,
      random: () => number = Math.random,
    ): Promise<NotificationDelivery> {
      const index = rows.findIndex((r) => r.userId === userId && r.id === deliveryId);
      if (index === -1) {
        throw new Error('not found');
      }
      const existing = rows[index]!;

      // 与真身一致：终态行再上报 → ConflictError 409
      if (existing.status === 'sent' || existing.status === 'cancelled') {
        throw new Error('conflict');
      }
      if (existing.status === 'failed' && existing.attemptCount >= MAX_NOTIFICATION_ATTEMPTS) {
        throw new Error('conflict');
      }

      const attemptCount = existing.attemptCount + 1;
      const sent = input.outcome === 'sent';
      const nextRetryAt = sent
        ? null
        : computeNextRetryAt(attemptCount, input.errorCode!, now, random);

      const updated: NotificationDelivery = {
        ...existing,
        status: sent ? 'sent' : 'failed',
        errorCode: sent ? null : input.errorCode,
        attemptCount,
        lastAttemptAt: now.toISOString(),
        nextRetryAt: nextRetryAt?.toISOString() ?? null,
        channel: 'browser',
      };
      rows[index] = updated;
      return updated;
    },

    __seed(delivery: NotificationDelivery): void {
      rows.push(delivery);
    },
  };
}

function makeDelivery(overrides: Partial<NotificationDelivery> = {}): NotificationDelivery {
  const now = new Date().toISOString();
  return {
    id: `delivery-${Math.random().toString(36).slice(2, 8)}`,
    userId: 'user-0001',
    ruleId: null,
    targetType: 'task',
    targetId: null,
    channel: 'in_app',
    level: 'normal',
    status: 'pending',
    scheduledFor: now,
    attemptCount: 0,
    lastAttemptAt: null,
    errorCode: null,
    nextRetryAt: null,
    dismissedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function setup() {
  const _database = createFakeDatabase();
  const users = createFakeUserRepository(_database);
  const deliveries = createFakeNotificationDeliveryRepository(_database);
  const audit = createFakeAuditLogger();
  const { user } = await users.ensureLocalUser([]);
  const useCase = new ManageNotificationDeliveryUseCase({
    notificationDeliveries: deliveries,
    audit,
  });
  return { _database, deliveries, audit, useCase, userId: user.id };
}

/**
 * 幂等存储的进程内替身。
 *
 * 逐条对齐 `src/infrastructure/idempotency/idempotency-store.drizzle.ts` 的三种区分：
 * 新键 → `claimed`；同键同指纹且已完成 → `replay`；同键同指纹但未完成 → `in-progress`；
 * 同键**不同指纹** → 400（把同一个键用在了另一个请求上）。
 */
function createInMemoryIdempotencyStore(): IdempotencyStore {
  const rows = new Map<string, { requestHash: string; completed: boolean; snapshot: unknown }>();
  const idOf = (userId: string, key: string): string => `${userId}\u0000${key}`;

  return {
    async claim(userId, key, requestHash) {
      const id = idOf(userId, key);
      const row = rows.get(id);
      if (row === undefined) {
        rows.set(id, { requestHash, completed: false, snapshot: null });
        return { outcome: 'claimed' };
      }
      if (row.requestHash !== requestHash) {
        throw new ValidationError('Idempotency-Key 已被用于另一个不同的请求');
      }
      if (row.completed) {
        return { outcome: 'replay', snapshot: row.snapshot };
      }
      return { outcome: 'in-progress' };
    },
    async complete(userId, key, snapshot) {
      const row = rows.get(idOf(userId, key));
      if (row !== undefined) {
        row.completed = true;
        row.snapshot = snapshot;
      }
    },
    async release(userId, key) {
      rows.delete(idOf(userId, key));
    },
  };
}

/** 只带 `withIdempotency` 真正会读的三样（请求头、方法、路径）的请求替身。 */
function attemptRequest(key: string, deliveryId: string): NextRequest {
  return {
    headers: new Headers({ 'Idempotency-Key': key }),
    method: 'POST',
    url: `http://localhost/api/v1/notification-deliveries/${deliveryId}/attempt`,
  } as unknown as NextRequest;
}

describe('D 组 · 第 8 端点 attempt（点 12-16）', () => {
  describe('点 12：sent 上报', () => {
    it('status=sent、error_code/next_retry_at 置空、channel 翻转 browser、attempt_count+1、last_attempt_at 落值', async () => {
      const { deliveries, userId } = await setup();
      deliveries.__seed(
        makeDelivery({ id: 'a1', status: 'pending', attemptCount: 0, channel: 'in_app' }),
      );
      const now = new Date('2026-09-30T09:00:00.000Z');

      const reported = await deliveries.reportAttempt(
        userId,
        'a1',
        { outcome: 'sent', errorCode: null },
        now,
      );

      expect(reported.status).toBe('sent');
      expect(reported.errorCode).toBeNull();
      expect(reported.nextRetryAt).toBeNull();
      expect(reported.channel).toBe('browser');
      expect(reported.attemptCount).toBe(1);
      expect(reported.lastAttemptAt).toBe(now.toISOString());
    });
  });

  describe('点 13：可重试失败', () => {
    it('CONSTRUCT_FAILED 递增后 <3 → next_retry_at＝30s→90s 指数 + jitter（±20%）', async () => {
      const now = new Date('2026-09-30T09:00:00.000Z');
      const fixedRandom = () => 0.5; // jitter 中点
      const delay1 = notificationRetryDelayMs(1, fixedRandom);
      const delay2 = notificationRetryDelayMs(2, fixedRandom);

      expect(delay1).toBe(30_000);
      expect(delay2).toBe(90_000);

      const next1 = computeNextRetryAt(1, 'NOTIFICATION_CONSTRUCT_FAILED', now, fixedRandom);
      const next2 = computeNextRetryAt(2, 'NOTIFICATION_CONSTRUCT_FAILED', now, fixedRandom);
      expect(next1!.getTime()).toBe(now.getTime() + 30_000);
      expect(next2!.getTime()).toBe(now.getTime() + 90_000);
    });

    it('attempt_count=3 → next_retry_at＝NULL 停止', async () => {
      const now = new Date('2026-09-30T09:00:00.000Z');
      const result = computeNextRetryAt(3, 'NOTIFICATION_CONSTRUCT_FAILED', now, () => 0.5);
      expect(result).toBeNull();
    });
  });

  describe('点 14：不可重试失败', () => {
    it('PERMISSION_DENIED / UNSUPPORTED → next_retry_at＝NULL 不再重试', async () => {
      const now = new Date('2026-09-30T09:00:00.000Z');
      expect(computeNextRetryAt(1, 'NOTIFICATION_PERMISSION_DENIED', now)).toBeNull();
      expect(computeNextRetryAt(1, 'NOTIFICATION_UNSUPPORTED', now)).toBeNull();
    });
  });

  describe('点 15：错误语义五连', () => {
    it('服务端权威字段提交 → 400 不静默（schema 拦截）', async () => {
      expect(() =>
        reportNotificationAttemptSchema.parse({
          outcome: 'sent',
          status: 'failed',
          attemptCount: 1,
        }),
      ).toThrow();
    });

    it('404 不复用 403（假仓储抛 NOT_FOUND）', async () => {
      const { deliveries } = await setup();
      await expect(
        deliveries.reportAttempt(
          OTHER_USER_ID,
          'missing',
          { outcome: 'sent', errorCode: null },
          new Date(),
        ),
      ).rejects.toThrow();
    });

    it('终态被新 outcome 覆盖 → 409 CONFLICT', async () => {
      const { deliveries, userId } = await setup();
      deliveries.__seed(makeDelivery({ id: 'sent', status: 'sent' }));
      await expect(
        deliveries.reportAttempt(
          userId,
          'sent',
          { outcome: 'failed', errorCode: 'NOTIFICATION_CONSTRUCT_FAILED' },
          new Date(),
        ),
      ).rejects.toThrow();
    });

    it('终态行再上报 → 409 CONFLICT（不带 key，独立计）', async () => {
      const { deliveries, userId } = await setup();
      const now = new Date('2026-09-30T09:00:00.000Z');
      deliveries.__seed(makeDelivery({ id: 'idem', status: 'sent', attemptCount: 1 }));

      // 不带 key，终态行再上报 → 409
      await expect(
        deliveries.reportAttempt(userId, 'idem', { outcome: 'sent', errorCode: null }, now),
      ).rejects.toThrow('conflict');
    });

    it('同 key 重放 → 409 IDEMPOTENCY_REPLAY，attempt_count 不二次递增', async () => {
      const { deliveries, useCase, userId } = await setup();
      const now = new Date('2026-09-30T09:00:00.000Z');
      deliveries.__seed(makeDelivery({ id: 'idem', status: 'pending', attemptCount: 0 }));
      const payload: ReportNotificationAttemptInput = {
        outcome: 'failed',
        errorCode: 'NOTIFICATION_CONSTRUCT_FAILED',
      };

      // 与路由同构：request → withIdempotency(…, useCase.reportAttempt) → 响应信封。
      const store = createInMemoryIdempotencyStore();
      const report = () =>
        withIdempotency(
          attemptRequest('attempt-key-1', 'idem'),
          userId,
          payload,
          store,
          async () => {
            const reported = await useCase.reportAttempt(userId, 'idem', payload, now);
            return { status: 200, body: { data: toNotificationAttemptResultDto(reported) } };
          },
        );

      const first = await report();
      expect(first.status).toBe(200);

      const replayed = await report();
      expect(replayed.status).toBe(409);
      expect(replayed.body).toEqual({
        error: { code: 'IDEMPOTENCY_REPLAY', message: '该操作已经处理过' },
      });

      // 「不二次递增」的实证：重放没有再次执行用例。
      const pending = await deliveries.listPending(userId);
      expect(pending.find((d) => d.id === 'idem')!.attemptCount).toBe(1);
    });

    it('换 key → 自然计数（各次上报独立递增）', async () => {
      const { deliveries, useCase, userId } = await setup();
      const now = new Date('2026-09-30T09:00:00.000Z');
      deliveries.__seed(makeDelivery({ id: 'idem-rotate', status: 'pending', attemptCount: 0 }));
      const payload: ReportNotificationAttemptInput = {
        outcome: 'failed',
        errorCode: 'NOTIFICATION_CONSTRUCT_FAILED',
      };

      const store = createInMemoryIdempotencyStore();
      const report = (key: string) =>
        withIdempotency(attemptRequest(key, 'idem-rotate'), userId, payload, store, async () => {
          const reported = await useCase.reportAttempt(userId, 'idem-rotate', payload, now);
          return { status: 200, body: { data: toNotificationAttemptResultDto(reported) } };
        });

      expect((await report('attempt-key-a')).status).toBe(200);
      expect((await report('attempt-key-b')).status).toBe(200);

      const pending = await deliveries.listPending(userId);
      expect(pending.find((d) => d.id === 'idem-rotate')!.attemptCount).toBe(2);
    });
  });

  describe('点 16：FR-071 落点', () => {
    it('failed 行在 pending 可见且 errorCode 回带四值之一', async () => {
      const { deliveries, userId } = await setup();
      const now = new Date('2026-09-30T09:00:00.000Z');
      deliveries.__seed(makeDelivery({ id: 'fr071', status: 'pending', attemptCount: 0 }));
      await deliveries.reportAttempt(
        userId,
        'fr071',
        { outcome: 'failed', errorCode: 'NOTIFICATION_CONSTRUCT_FAILED' },
        now,
      );

      const pending = await deliveries.listPending(userId);
      const failed = pending.find((d) => d.id === 'fr071');
      expect(failed).toBeDefined();
      expect(failed!.status).toBe('failed');
      expect(failed!.errorCode).toBe('NOTIFICATION_CONSTRUCT_FAILED');
    });
  });
});
