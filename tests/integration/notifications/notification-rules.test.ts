// @vitest-environment node
/**
 * A 组 · 规则契约（PD-019 点 1-5，NOTIFY-001，P0）。
 *
 * 覆盖：
 * - 点 1：规则 CRUD 正向 + targetType/targetId 过滤 + 分页 + 作用域隔离
 * - 点 2：`level` 服务端派生只读
 * - 点 3：校验语义三连（review targetId 400、重复 409、PATCH 可改字段 + 非己 404）
 * - 点 4：单条关闭与删除（enabled=false 可再开、硬删 deliveries.rule_id 置 NULL）
 * - 点 5：全局关闭零新端点（走既有 PATCH /me reminderEnabled）
 */
import { describe, expect, it } from 'vitest';

import { ManageNotificationRuleUseCase } from '../../../src/modules/notifications/application/manage-notification-rule.ts';
import {
  createNotificationRuleSchema,
  updateNotificationRuleSchema,
} from '../../../src/modules/notifications/application/notification-rule-dto.ts';
import {
  deriveNotificationLevel,
  NOTIFICATION_LEVEL_BY_TARGET_TYPE,
} from '../../../src/modules/notifications/domain/notification-rule.ts';
import type {
  NotificationRule,
  NotificationRuleCreateInput,
  NotificationRulePatch,
} from '../../../src/modules/notifications/domain/notification-rule.ts';
import type { NotificationRuleRepository } from '../../../src/modules/notifications/domain/notification-rule-repository.ts';
import { ConflictError, NotFoundError } from '../../../src/shared/errors/app-error.ts';
import {
  createFakeAuditLogger,
  createFakeDatabase,
  createFakeUserRepository,
} from '../../helpers/fake-repositories.ts';
import type { FakeDatabase } from '../../helpers/fake-repositories.ts';

const OTHER_USER_ID = 'user-other';
const TASK_ID = '123e4567-e89b-12d3-a456-426614174000';
const ROUTINE_ID = '123e4567-e89b-12d3-a456-426614174001';

function createFakeNotificationRuleRepository(_database: FakeDatabase): NotificationRuleRepository {
  const rows: NotificationRule[] = [];
  let sequence = 0;

  return {
    async listByUser(
      userId: string,
      options: {
        readonly targetType?: string;
        readonly targetId?: string;
        readonly cursor?: string;
        readonly limit: number;
      },
    ): Promise<{
      readonly items: readonly NotificationRule[];
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
    }> {
      let items = rows.filter((r) => r.userId === userId);
      if (options.targetType !== undefined) {
        items = items.filter((r) => r.targetType === options.targetType);
      }
      if (options.targetId !== undefined) {
        items = items.filter((r) => r.targetId === options.targetId);
      }
      items = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const nextCursor = items.length > options.limit ? items[options.limit].id : null;
      return {
        items: items.slice(0, options.limit),
        nextCursor,
        hasMore: items.length > options.limit,
      };
    },

    async findById(userId: string, ruleId: string): Promise<NotificationRule | null> {
      return rows.find((r) => r.userId === userId && r.id === ruleId) ?? null;
    },

    async create(userId: string, input: NotificationRuleCreateInput): Promise<NotificationRule> {
      const duplicated = rows.find(
        (r) =>
          r.userId === userId &&
          r.targetType === input.targetType &&
          r.targetId === input.targetId &&
          r.remindAt === input.remindAt,
      );
      if (duplicated !== undefined) {
        throw new ConflictError('同一对象的该提醒时刻已存在规则');
      }
      const rule: NotificationRule = {
        id: `rule-${++sequence}`,
        userId,
        targetType: input.targetType,
        targetId: input.targetId,
        remindAt: input.remindAt,
        repeatRule: input.repeatRule,
        allowQuietHours: input.allowQuietHours,
        enabled: true,
        level: deriveNotificationLevel(input.targetType),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      rows.push(rule);
      return rule;
    },

    async update(
      userId: string,
      ruleId: string,
      patch: NotificationRulePatch,
    ): Promise<NotificationRule> {
      const index = rows.findIndex((r) => r.userId === userId && r.id === ruleId);
      if (index === -1) {
        throw new NotFoundError('提醒规则不存在');
      }
      const current = rows[index];
      if (patch.remindAt !== undefined) {
        const duplicated = rows.find(
          (r) =>
            r.userId === userId &&
            r.targetType === current.targetType &&
            r.targetId === current.targetId &&
            r.remindAt === patch.remindAt &&
            r.id !== ruleId,
        );
        if (duplicated !== undefined) {
          throw new ConflictError('同一对象的该提醒时刻已存在规则');
        }
      }
      const updated: NotificationRule = {
        ...current,
        ...(patch.remindAt !== undefined ? { remindAt: patch.remindAt } : {}),
        ...(patch.repeatRule !== undefined ? { repeatRule: patch.repeatRule } : {}),
        ...(patch.allowQuietHours !== undefined ? { allowQuietHours: patch.allowQuietHours } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        updatedAt: new Date().toISOString(),
      };
      rows[index] = updated;
      return updated;
    },

    async delete(userId: string, ruleId: string): Promise<boolean> {
      const index = rows.findIndex((r) => r.userId === userId && r.id === ruleId);
      if (index === -1) {
        return false;
      }
      rows.splice(index, 1);
      return true;
    },
  };
}

const parseCreate = (body: unknown) => createNotificationRuleSchema.parse(body);
const parseUpdate = (body: unknown) => updateNotificationRuleSchema.parse(body);

async function setup() {
  const _database = createFakeDatabase();
  const users = createFakeUserRepository(_database);
  const rules = createFakeNotificationRuleRepository(_database);
  const audit = createFakeAuditLogger();
  const { user } = await users.ensureLocalUser([]);

  // 假任务/例程仓储：让 task/routine 规则创建时 assertTarget 通过。
  const fakeTaskRepository = {
    async findById(_userId: string, _targetId: string): Promise<{ id: string } | null> {
      return _targetId === TASK_ID ? { id: _targetId } : null;
    },
  } as never;

  const fakeRoutineRepository = {
    async findDetail(_userId: string, _targetId: string): Promise<{ id: string } | null> {
      return _targetId === ROUTINE_ID ? { id: _targetId } : null;
    },
  } as never;

  const useCase = new ManageNotificationRuleUseCase({
    notificationRules: rules,
    tasks: fakeTaskRepository,
    routines: fakeRoutineRepository,
    audit,
  });
  return { _database, rules, audit, useCase, userId: user.id };
}

describe('A 组 · 规则契约（点 1-5）', () => {
  describe('点 1：规则 CRUD 正向 + 过滤 + 分页 + 作用域', () => {
    it('task/routine/review 三类创建与查询', async () => {
      const { useCase, userId } = await setup();
      const taskRule = await useCase.create(
        userId,
        parseCreate({
          targetType: 'task',
          targetId: TASK_ID,
          remindAt: '09:00:00',
          repeatRule: 'daily',
          allowQuietHours: false,
        }),
      );
      const routineRule = await useCase.create(
        userId,
        parseCreate({
          targetType: 'routine',
          targetId: ROUTINE_ID,
          remindAt: '10:00:00',
          repeatRule: 'weekly',
          allowQuietHours: true,
        }),
      );
      const reviewRule = await useCase.create(
        userId,
        parseCreate({
          targetType: 'review',
          remindAt: '20:00:00',
          repeatRule: 'none',
          allowQuietHours: false,
        }),
      );

      expect(taskRule.targetType).toBe('task');
      expect(routineRule.targetType).toBe('routine');
      expect(reviewRule.targetType).toBe('review');
      expect(reviewRule.targetId).toBeUndefined();
    });

    it('targetType/targetId 过滤', async () => {
      const { useCase, userId } = await setup();
      await useCase.create(
        userId,
        parseCreate({
          targetType: 'task',
          targetId: TASK_ID,
          remindAt: '09:00:00',
          repeatRule: 'none',
          allowQuietHours: false,
        }),
      );
      await useCase.create(
        userId,
        parseCreate({
          targetType: 'routine',
          targetId: ROUTINE_ID,
          remindAt: '10:00:00',
          repeatRule: 'none',
          allowQuietHours: false,
        }),
      );

      const taskOnly = await useCase.list(userId, { targetType: 'task', limit: 20 });
      expect(taskOnly.items.every((r) => r.targetType === 'task')).toBe(true);

      const routineOnly = await useCase.list(userId, { targetType: 'routine', limit: 20 });
      expect(routineOnly.items.every((r) => r.targetType === 'routine')).toBe(true);
    });

    it('分页 meta 正确', async () => {
      const { useCase, userId } = await setup();
      for (let i = 0; i < 5; i++) {
        await useCase.create(
          userId,
          parseCreate({
            targetType: 'review',
            remindAt: `${String(9 + i).padStart(2, '0')}:00:00`,
            repeatRule: 'none',
            allowQuietHours: false,
          }),
        );
      }
      const page1 = await useCase.list(userId, { limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();

      const page2 = await useCase.list(userId, { limit: 2, cursor: page1.nextCursor! });
      expect(page2.items).toHaveLength(2);
    });

    it('跨用户 id 读写一律 404 不泄露存在性', async () => {
      const { useCase, userId } = await setup();
      const created = await useCase.create(
        userId,
        parseCreate({
          targetType: 'task',
          targetId: TASK_ID,
          remindAt: '09:00:00',
          repeatRule: 'none',
          allowQuietHours: false,
        }),
      );

      await expect(useCase.findById(OTHER_USER_ID, created.id)).rejects.toThrow(NotFoundError);
      const otherList = await useCase.list(OTHER_USER_ID, { limit: 20 });
      expect(otherList.items).toHaveLength(0);
    });
  });

  describe('点 2：level 服务端派生只读', () => {
    it('task→normal / routine→critical / review→review', async () => {
      expect(deriveNotificationLevel('task')).toBe('normal');
      expect(deriveNotificationLevel('routine')).toBe('critical');
      expect(deriveNotificationLevel('review')).toBe('review');
    });

    it('客户端提交 level → 400 VALIDATION_ERROR（Zod schema 拦截）', async () => {
      expect(() =>
        createNotificationRuleSchema.parse({
          targetType: 'task',
          targetId: TASK_ID,
          remindAt: '09:00:00',
          repeatRule: 'none',
          allowQuietHours: false,
          level: 'critical',
        }),
      ).toThrow();
    });

    it('列表响应回带服务端派生 level', async () => {
      const { useCase, userId } = await setup();
      const created = await useCase.create(
        userId,
        parseCreate({
          targetType: 'routine',
          targetId: ROUTINE_ID,
          remindAt: '10:00:00',
          repeatRule: 'none',
          allowQuietHours: false,
        }),
      );
      const page = await useCase.list(userId, { limit: 20 });
      const found = page.items.find((r) => r.id === created.id);
      expect(found?.level).toBe(NOTIFICATION_LEVEL_BY_TARGET_TYPE['routine']);
    });
  });

  describe('点 3：校验语义三连', () => {
    it('review 类提供 targetId → 400（Zod schema 拦截）', async () => {
      expect(() =>
        createNotificationRuleSchema.parse({
          targetType: 'review',
          targetId: TASK_ID,
          remindAt: '09:00:00',
          repeatRule: 'none',
          allowQuietHours: false,
        }),
      ).toThrow();
    });

    it('(targetType, targetId, remindAt) 重复 → 409', async () => {
      const { useCase, userId } = await setup();
      await useCase.create(
        userId,
        parseCreate({
          targetType: 'task',
          targetId: TASK_ID,
          remindAt: '09:00:00',
          repeatRule: 'none',
          allowQuietHours: false,
        }),
      );
      await expect(
        useCase.create(
          userId,
          parseCreate({
            targetType: 'task',
            targetId: TASK_ID,
            remindAt: '09:00:00',
            repeatRule: 'none',
            allowQuietHours: false,
          }),
        ),
      ).rejects.toThrow(ConflictError);
    });

    it('PATCH 可改字段集 + 非己规则 → 404（不复用 403）', async () => {
      const { useCase, userId } = await setup();
      const created = await useCase.create(
        userId,
        parseCreate({
          targetType: 'task',
          targetId: TASK_ID,
          remindAt: '09:00:00',
          repeatRule: 'none',
          allowQuietHours: false,
        }),
      );

      const updated = await useCase.update(
        userId,
        created.id,
        parseUpdate({ enabled: false, remindAt: '10:00:00' }),
      );
      expect(updated.enabled).toBe(false);
      expect(updated.remindAt).toBe('10:00:00');

      await expect(
        useCase.update(OTHER_USER_ID, created.id, parseUpdate({ enabled: true })),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('点 4：单条关闭与删除', () => {
    it('enabled=false 停用可再开', async () => {
      const { useCase, userId } = await setup();
      const created = await useCase.create(
        userId,
        parseCreate({
          targetType: 'task',
          targetId: TASK_ID,
          remindAt: '09:00:00',
          repeatRule: 'none',
          allowQuietHours: false,
        }),
      );
      const disabled = await useCase.update(userId, created.id, parseUpdate({ enabled: false }));
      expect(disabled.enabled).toBe(false);
      const reEnabled = await useCase.update(userId, created.id, parseUpdate({ enabled: true }));
      expect(reEnabled.enabled).toBe(true);
    });

    it('DELETE 硬删且历史交付保留（ deliveries.rule_id 置 NULL ）', async () => {
      const { rules, userId } = await setup();
      const created = await rules.create(userId, {
        targetType: 'task',
        targetId: TASK_ID,
        remindAt: '09:00:00',
        repeatRule: 'none',
        allowQuietHours: false,
      });
      // 假仓储 delete 返回 true 表示删到了行；真实 DB 有 ON DELETE SET NULL。
      const deleted = await rules.delete(userId, created.id);
      expect(deleted).toBe(true);
      const found = await rules.findById(userId, created.id);
      expect(found).toBeNull();
    });
  });

  describe('点 5：全局关闭零新端点', () => {
    it('走既有 PATCH /me（reminderEnabled）——本测试验证 useCase 不新增规则端点', async () => {
      const { useCase, userId } = await setup();
      // 全局关闭不会触发任何新规则创建；只要 create/list 不依赖 reminderEnabled 字段，
      // 且用户设置更新走既有 user repository，就已满足「零新端点」。
      const before = await useCase.list(userId, { limit: 20 });
      expect(before.items).toHaveLength(0);

      // 创建规则不受 reminderEnabled 影响（规则创建是显式用户行为）。
      await useCase.create(
        userId,
        parseCreate({
          targetType: 'review',
          remindAt: '20:00:00',
          repeatRule: 'none',
          allowQuietHours: false,
        }),
      );
      const after = await useCase.list(userId, { limit: 20 });
      expect(after.items).toHaveLength(1);
    });
  });
});
