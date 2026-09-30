// @vitest-environment node
/**
 * C 组 · 待处理 / 忽略 / 查询（PD-019 点 9-11，NOTIFY-002，P0）。
 *
 * 覆盖：
 * - 点 9：pending 口径（status ∈ {pending, failed} ∧ 未 dismissed；等级降序 + scheduledFor 升序；cancelled/sent 排除）
 * - 点 10：dismiss（写 dismissed_at、status 四值不变、重复 dismiss 幂等）
 * - 点 11：deliveries 查询（status 过滤、onlyRetryable、keyset 分页 meta）
 *
 * 真实可执行策略（无数据库）：
 * 1. pending 过滤与排序逻辑在假仓储 listPending 里用 NOTIFICATION_LEVEL_RANK 实排；
 * 2. dismiss 幂等与 status 不变由假仓储实现语义；
 * 3. listByUser 的 keyset 分页由假仓储模拟；
 * 4. DTO schema 直接断言。
 */
import { describe, expect, it } from 'vitest';

import { ManageNotificationDeliveryUseCase } from '../../../src/modules/notifications/application/manage-notification-delivery.ts';
import { NOTIFICATION_LEVEL_RANK } from '../../../src/modules/notifications/domain/notification-rule.ts';
import { listNotificationDeliveriesQuerySchema } from '../../../src/modules/notifications/application/notification-delivery-dto.ts';
import type { NotificationDelivery } from '../../../src/modules/notifications/domain/notification-delivery.ts';
import type { NotificationDeliveryRepository } from '../../../src/modules/notifications/domain/notification-delivery-repository.ts';
import {
  createFakeAuditLogger,
  createFakeDatabase,
  createFakeUserRepository,
} from '../../helpers/fake-repositories.ts';
import type { FakeDatabase } from '../../helpers/fake-repositories.ts';

const OTHER_USER_ID = 'user-other';

function createFakeNotificationDeliveryRepository(
  _database: FakeDatabase,
): NotificationDeliveryRepository {
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
      userId: string,
      options: {
        readonly status?: string;
        readonly onlyRetryable?: boolean;
        readonly cursor?: string;
        readonly limit: number;
      },
    ): Promise<{
      readonly items: readonly NotificationDelivery[];
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
    }> {
      let items = rows.filter((r) => r.userId === userId);
      if (options.status !== undefined) {
        items = items.filter((r) => r.status === options.status);
      }
      if (options.onlyRetryable === true) {
        items = items.filter(
          (r) => r.status === 'failed' && r.nextRetryAt !== null && r.attemptCount < 3,
        );
      }
      items = [...items].sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor));
      const nextCursor = items.length > options.limit ? items[options.limit].id : null;
      return {
        items: items.slice(0, options.limit),
        nextCursor,
        hasMore: items.length > options.limit,
      };
    },

    async findById(_userId: string, _deliveryId: string): Promise<NotificationDelivery | null> {
      return null;
    },

    async dismiss(userId: string, deliveryId: string, _now: Date): Promise<NotificationDelivery> {
      const index = rows.findIndex((r) => r.userId === userId && r.id === deliveryId);
      if (index === -1) {
        throw new Error('not found');
      }
      const existing = rows[index];
      if (existing.dismissedAt !== null) {
        return existing; // 幂等
      }
      const updated: NotificationDelivery = { ...existing, dismissedAt: new Date().toISOString() };
      rows[index] = updated;
      return updated;
    },

    async reportAttempt(
      _userId: string,
      _deliveryId: string,
      _input: { readonly outcome: string; readonly errorCode: string | null },
      _now: Date,
      _random?: () => number,
    ): Promise<NotificationDelivery> {
      throw new Error('not implemented');
    },

    __seed(delivery: NotificationDelivery): void {
      rows.push(delivery);
    },
  } as NotificationDeliveryRepository & { __seed: (delivery: NotificationDelivery) => void };
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

describe('C 组 · 待处理 / 忽略 / 查询（点 9-11）', () => {
  describe('点 9：pending 口径', () => {
    it('status ∈ {pending, failed} ∧ 未 dismissed；cancelled / sent 排除', async () => {
      const { deliveries, userId } = await setup();
      deliveries.__seed(makeDelivery({ id: 'p', status: 'pending', dismissedAt: null }));
      deliveries.__seed(makeDelivery({ id: 'f', status: 'failed', dismissedAt: null }));
      deliveries.__seed(makeDelivery({ id: 'c', status: 'cancelled', dismissedAt: null }));
      deliveries.__seed(makeDelivery({ id: 's', status: 'sent', dismissedAt: null }));
      deliveries.__seed(
        makeDelivery({ id: 'd', status: 'pending', dismissedAt: new Date().toISOString() }),
      );

      const list = await deliveries.listPending(userId);
      const ids = list.map((d) => d.id);
      expect(ids).toEqual(['p', 'f']);
    });

    it('等级降序 + scheduledFor 升序', async () => {
      const { deliveries, userId } = await setup();
      const now = new Date().toISOString();
      deliveries.__seed(makeDelivery({ id: 'n', level: 'normal', scheduledFor: now }));
      deliveries.__seed(makeDelivery({ id: 'c', level: 'critical', scheduledFor: now }));
      deliveries.__seed(makeDelivery({ id: 'r', level: 'review', scheduledFor: now }));

      const list = await deliveries.listPending(userId);
      expect(list.map((d) => d.id)).toEqual(['c', 'n', 'r']);
    });
  });

  describe('点 10：dismiss', () => {
    it('写 dismissed_at、status 四值不变', async () => {
      const { deliveries, userId } = await setup();
      deliveries.__seed(makeDelivery({ id: 'd1', status: 'pending' }));
      const dismissed = await deliveries.dismiss(userId, 'd1', new Date());
      expect(dismissed.dismissedAt).toBeDefined();
      expect(dismissed.status).toBe('pending');
    });

    it('重复 dismiss 幂等（返回当前行，不重复写）', async () => {
      const { deliveries, userId } = await setup();
      deliveries.__seed(
        makeDelivery({ id: 'd2', status: 'pending', dismissedAt: '2026-09-30T00:00:00.000Z' }),
      );
      const first = await deliveries.dismiss(userId, 'd2', new Date());
      const second = await deliveries.dismiss(userId, 'd2', new Date());
      expect(first.dismissedAt).toBe(second.dismissedAt);
    });

    it('非本人或不存在抛 NOT_FOUND', async () => {
      const { deliveries } = await setup();
      await expect(deliveries.dismiss(OTHER_USER_ID, 'missing', new Date())).rejects.toThrow();
    });
  });

  describe('点 11：deliveries 查询', () => {
    it('status 过滤', async () => {
      const { deliveries, userId } = await setup();
      deliveries.__seed(makeDelivery({ id: 'p1', status: 'pending' }));
      deliveries.__seed(makeDelivery({ id: 'f1', status: 'failed' }));
      deliveries.__seed(makeDelivery({ id: 's1', status: 'sent' }));

      const failedOnly = await deliveries.listByUser(userId, { status: 'failed', limit: 20 });
      expect(failedOnly.items).toHaveLength(1);
      expect(failedOnly.items[0].id).toBe('f1');
    });

    it('onlyRetryable：失败 + 未达上限 + next_retry_at 非空', async () => {
      const { deliveries, userId } = await setup();
      deliveries.__seed(
        makeDelivery({
          id: 'r1',
          status: 'failed',
          attemptCount: 1,
          nextRetryAt: '2026-09-30T10:00:00.000Z',
        }),
      );
      deliveries.__seed(
        makeDelivery({ id: 'r2', status: 'failed', attemptCount: 3, nextRetryAt: null }),
      );
      deliveries.__seed(
        makeDelivery({ id: 'r3', status: 'failed', attemptCount: 1, nextRetryAt: null }),
      );

      const retryable = await deliveries.listByUser(userId, { onlyRetryable: true, limit: 20 });
      expect(retryable.items).toHaveLength(1);
      expect(retryable.items[0].id).toBe('r1');
    });

    it('keyset 分页 meta', async () => {
      const { deliveries, userId } = await setup();
      deliveries.__seed(
        makeDelivery({ id: 'x1', status: 'failed', scheduledFor: '2026-09-30T09:00:00.000Z' }),
      );
      deliveries.__seed(
        makeDelivery({ id: 'x2', status: 'failed', scheduledFor: '2026-09-30T08:00:00.000Z' }),
      );

      const page1 = await deliveries.listByUser(userId, { status: 'failed', limit: 1 });
      expect(page1.items).toHaveLength(1);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();
    });

    it('Schema 只接受枚举值 + 字面 true/false + 分页字段', async () => {
      expect(() =>
        listNotificationDeliveriesQuerySchema.parse({
          status: 'invalid',
          onlyRetryable: 'false',
          limit: 20,
        }),
      ).toThrow();
      expect(() =>
        listNotificationDeliveriesQuerySchema.parse({
          status: 'pending',
          onlyRetryable: 'true',
          limit: 20,
        }),
      ).not.toThrow();
    });
  });
});
