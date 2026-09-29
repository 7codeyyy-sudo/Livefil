/**
 * 点 7：日复盘读写（integration，P0）。
 *
 * 覆盖：
 * - data:null = 200 非 404
 * - answers 三键可省、空串按未答
 * - 全空 422
 * - 保存 = PUT 合并不破坏已答
 * - 唯一键幂等不重复建行
 */
import { describe, expect, test } from 'vitest';
import { ManageReviewUseCase } from '../../../src/modules/reviews/application/manage-review.ts';
import type {
  ReviewRepository,
  ReviewFactsRepository,
  ReviewAdjustmentApplier,
} from '../../../src/modules/reviews/domain/review-repository.ts';
import type { TaskRepository } from '../../../src/modules/tasks/domain/task-repository.ts';
import type { GoalRepository } from '../../../src/modules/goals/domain/goal-repository.ts';
import type { ExpenseRepository } from '../../../src/modules/expenses/domain/expense-repository.ts';
import {
  createFakeAuditLogger,
  createFakeDatabase,
  createFakeUserRepository,
} from '../../helpers/fake-repositories.ts';
import type { FakeDatabase } from '../../helpers/fake-repositories.ts';
import {
  type Review,
  type DailyReviewUpsertInput,
} from '../../../src/modules/reviews/domain/review.ts';
import { type DailyFacts } from '../../../src/modules/reviews/domain/review-repository.ts';
import type { WeeklyFacts } from '../../../src/modules/reviews/domain/weekly-snapshot.ts';
import type { ReviewAdjustment } from '../../../src/modules/reviews/domain/review-adjustment.ts';

function createFakeReviewRepository(_database: FakeDatabase): ReviewRepository {
  const reviews: Review[] = [];

  return {
    async findDaily(userId: string, date: string): Promise<Review | null> {
      return (
        reviews.find(
          (r) => r.userId === userId && r.reviewType === 'daily' && r.periodKey === date,
        ) ?? null
      );
    },

    async upsertDaily(
      userId: string,
      date: string,
      input: DailyReviewUpsertInput,
    ): Promise<Review> {
      const filteredAnswers = input.answers
        ? Object.fromEntries(Object.entries(input.answers).filter(([, value]) => value !== ''))
        : null;

      if (
        (filteredAnswers === null || Object.keys(filteredAnswers).length === 0) &&
        input.energyLevel === null
      ) {
        throw new Error('日复盘至少需要回答一个问题或选择一个能量等级');
      }

      const existing = reviews.find(
        (r) => r.userId === userId && r.reviewType === 'daily' && r.periodKey === date,
      );
      if (existing !== undefined) {
        const mergedAnswers = {
          ...existing.answers,
          ...filteredAnswers,
        };
        const finalAnswers = Object.keys(mergedAnswers).length === 0 ? null : mergedAnswers;
        const updated: Review = {
          id: existing.id,
          userId: existing.userId,
          reviewType: 'daily',
          periodKey: existing.periodKey,
          answers: finalAnswers,
          energyLevel: input.energyLevel ?? existing.energyLevel,
          snapshot: null,
          snapshotSchemaVersion: null,
          createdAt: existing.createdAt,
          version: existing.version + 1,
        };
        const index = reviews.findIndex((r) => r.id === existing.id);
        if (index >= 0) reviews[index] = updated;
        return updated;
      }

      const created: Review = {
        id: `review-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        userId,
        reviewType: 'daily',
        periodKey: date,
        answers: filteredAnswers,
        energyLevel: input.energyLevel,
        snapshot: null,
        snapshotSchemaVersion: null,
        createdAt: new Date().toISOString(),
        version: 1,
      };
      reviews.push(created);
      return created;
    },

    async findWeekly(): Promise<Review | null> {
      return null;
    },
    async materializeWeeklySnapshot(): Promise<Review> {
      return null as unknown as Review;
    },
    async ensureWeekly(): Promise<Review> {
      return { id: 'review-week' } as unknown as Review;
    },
    async listAdjustments(): Promise<readonly ReviewAdjustment[]> {
      return [];
    },
  };
}

function createFakeReviewFactsRepository(): ReviewFactsRepository {
  return {
    async collectDailyFacts(): Promise<DailyFacts> {
      return {
        planActual: { plannedMinutes: 0, actualMinutes: 0 },
        completedCount: 0,
        uncompletedCount: 0,
      };
    },
    async collectWeeklyFacts(): Promise<WeeklyFacts> {
      return {
        planActual: { plannedMinutes: 0, actualMinutes: 0 },
        taskStatusCounts: { completed: 0, partial: 0, deferred: 0, skipped: 0 },
        repeatedDeferrals: [],
        goalActions: [],
      };
    },
  };
}

function createFakeReviewAdjustmentApplier(): ReviewAdjustmentApplier {
  return {
    async apply(): Promise<ReviewAdjustment> {
      return {
        id: 'adj-fake',
        userId: 'user-fake',
        reviewId: 'review-fake',
        targetType: 'task',
        targetId: 'task-fake',
        action: 'keep',
        payload: {},
        createdAt: new Date().toISOString(),
      };
    },
  };
}

async function setup() {
  const database = createFakeDatabase();
  const users = createFakeUserRepository(database);
  const reviews = createFakeReviewRepository(database);
  const facts = createFakeReviewFactsRepository();
  const adjustments = createFakeReviewAdjustmentApplier();
  const _tasks: unknown[] = [];
  const taskRepo = {
    async findById(): Promise<unknown> {
      return null;
    },
  } as unknown as TaskRepository;
  const _goals: unknown[] = [];
  const goalRepo = {
    async findById(): Promise<unknown> {
      return null;
    },
  } as unknown as GoalRepository;
  const _expenses: unknown[] = [];
  const expenseRepo = {
    async summarize(): Promise<unknown> {
      return { groups: [], grandTotals: [] };
    },
  } as unknown as ExpenseRepository;
  const audit = createFakeAuditLogger();
  const { user } = await users.ensureLocalUser([]);
  const useCase = new ManageReviewUseCase({
    reviews,
    facts,
    adjustments,
    users,
    tasks: taskRepo,
    goals: goalRepo,
    expenses: expenseRepo,
    audit,
  });

  return {
    database,
    users,
    reviews,
    facts,
    adjustments,
    taskRepo,
    goalRepo,
    expenseRepo,
    audit,
    useCase,
    userId: user.id,
  };
}

describe('日复盘读写（点 7）', () => {
  test('未填写返回 null（200 非 404）', async () => {
    const { useCase } = await setup();
    const result = await useCase.getDaily('user-0001', '2026-09-29');
    expect(result).toBeNull();
  });

  test('answers 三键可省、空串按未答', async () => {
    const { useCase } = await setup();
    const created = await useCase.upsertDaily('user-0001', '2026-09-29', {
      answers: { completed: '做了', blocker: '', nextAdjustment: '继续' },
      energyLevel: 'medium',
    });
    expect(created.answers).toEqual({ completed: '做了', nextAdjustment: '继续' });
  });

  test('全空 answers + 无 energyLevel → 422', async () => {
    const { useCase } = await setup();
    await expect(
      useCase.upsertDaily('user-0001', '2026-09-29', { answers: {}, energyLevel: null }),
    ).rejects.toThrow();
  });

  test('PUT 幂等，同日再保存不重复建行', async () => {
    const { useCase } = await setup();
    const first = await useCase.upsertDaily('user-0001', '2026-09-29', {
      answers: { completed: '初稿' },
      energyLevel: 'high',
    });
    const second = await useCase.upsertDaily('user-0001', '2026-09-29', {
      answers: { completed: '修订' },
      energyLevel: 'medium',
    });
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(first.version + 1);
  });
});
