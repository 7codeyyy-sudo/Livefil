/**
 * 复盘仓储与调整施加器的 Drizzle 实现（REVIEW-001~003）。
 *
 * 贯穿全文件的三条纪律：
 *
 * - **每条查询都带 `userId`**（含事务内的目标写入），作用域谓词直接写在 where 里；
 * - **`updated_at` 必须前移**：`onConflictDoUpdate` 的 `.set` 不走 Drizzle 的
 *   `$onUpdate`（那只随 Drizzle 的 update 链生效），而同步增量拉取的 `changeAt`
 *   是 `coalesce(updated_at, created_at)`——漏掉它，同日第二次保存对增量拉取不可见；
 * - **空结果要分 404 与 409**：乐观并发的空返回可能来自"目标不存在/已软删"，
 *   也可能来自"版本已前移"，两者给调用方的语义完全不同。
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import {
  goals,
  reviewAdjustments,
  reviews,
  tasks,
  type ReviewAdjustmentRow,
  type ReviewRow,
} from '@/infrastructure/database/schema.ts';
import { ConflictError, InvariantError, NotFoundError } from '@/shared/errors/app-error.ts';
import { ENERGY_LEVELS, type EnergyLevel } from '../../execution/domain/execution-log.ts';

import {
  isAdjustmentAction,
  isAdjustmentTargetType,
  type AdjustmentPayload,
  type AdjustmentWrite,
  type ReviewAdjustment,
  type ReviewAdjustmentCreateInput,
} from '../domain/review-adjustment.ts';
import {
  isReviewType,
  readReviewAnswers,
  type Review,
  type DailyReviewUpsertInput,
} from '../domain/review.ts';
import type { ReviewAdjustmentApplier, ReviewRepository } from '../domain/review-repository.ts';
import { readWeeklySnapshot, type WeeklySnapshot } from '../domain/weekly-snapshot.ts';

/** 行 → 实体。来源与枚举不符（有人绕过应用写库）时明确报错而不是放行。 */
function toReview(row: ReviewRow): Review {
  if (!isReviewType(row.reviewType)) {
    throw new InvariantError({ message: 'reviews.review_type 的取值不在契约集合内' });
  }
  const energyLevel = row.energyLevel;
  if (energyLevel !== null && !(ENERGY_LEVELS as readonly string[]).includes(energyLevel)) {
    throw new InvariantError({ message: 'reviews.energy_level 的取值不在契约集合内' });
  }
  return {
    id: row.id,
    userId: row.userId,
    reviewType: row.reviewType,
    periodKey: row.periodKey,
    answers: readReviewAnswers(row.answers),
    energyLevel: (energyLevel as EnergyLevel | null) ?? null,
    snapshot: readWeeklySnapshot(row.snapshot),
    snapshotSchemaVersion: row.snapshotSchemaVersion,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

/** `payload` 回读：只接受对象（`jsonb` 可能被写成数组/标量，那属于数据损坏）。 */
function toAdjustmentPayload(value: unknown): AdjustmentPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvariantError({ message: 'review_adjustments.payload 不是对象' });
  }
  return value as AdjustmentPayload;
}

/** 行 → 调整记录。 */
function toAdjustment(row: ReviewAdjustmentRow): ReviewAdjustment {
  if (!isAdjustmentTargetType(row.targetType)) {
    throw new InvariantError({ message: 'review_adjustments.target_type 的取值不在契约集合内' });
  }
  if (!isAdjustmentAction(row.action)) {
    throw new InvariantError({ message: 'review_adjustments.action 的取值不在契约集合内' });
  }
  return {
    id: row.id,
    userId: row.userId,
    reviewId: row.reviewId,
    targetType: row.targetType,
    targetId: row.targetId,
    action: row.action,
    payload: toAdjustmentPayload(row.payload),
    createdAt: row.createdAt.toISOString(),
  };
}

export function createReviewRepository(db: Database): ReviewRepository {
  return {
    async findDaily(userId: string, date: string): Promise<Review | null> {
      const rows = await db
        .select()
        .from(reviews)
        .where(
          and(
            eq(reviews.userId, userId),
            eq(reviews.reviewType, 'daily'),
            eq(reviews.periodKey, date),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toReview(row);
    },

    async findWeekly(userId: string, weekStart: string): Promise<Review | null> {
      const rows = await db
        .select()
        .from(reviews)
        .where(
          and(
            eq(reviews.userId, userId),
            eq(reviews.reviewType, 'weekly'),
            eq(reviews.periodKey, weekStart),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toReview(row);
    },

    async upsertDaily(
      userId: string,
      date: string,
      input: DailyReviewUpsertInput,
    ): Promise<Review> {
      const rows = await db
        .insert(reviews)
        .values({
          userId,
          reviewType: 'daily',
          periodKey: date,
          answers: input.answers,
          energyLevel: input.energyLevel,
        })
        .onConflictDoUpdate({
          target: [reviews.userId, reviews.reviewType, reviews.periodKey],
          set: {
            answers: input.answers,
            energyLevel: input.energyLevel,
            version: sql`${reviews.version} + 1`,
            // 显式写 `updated_at`：冲突分支不走 `$onUpdate`，而同步增量拉取靠它。
            updatedAt: new Date(),
          },
        })
        .returning();

      const row = rows[0];
      if (row === undefined) {
        throw new InvariantError({ message: '保存日复盘后数据库未返回记录' });
      }
      return toReview(row);
    },

    async ensureWeekly(userId: string, weekStart: string): Promise<Review> {
      const inserted = await db
        .insert(reviews)
        .values({ userId, reviewType: 'weekly', periodKey: weekStart })
        .onConflictDoNothing({ target: [reviews.userId, reviews.reviewType, reviews.periodKey] })
        .returning();

      const created = inserted[0];
      if (created !== undefined) {
        return toReview(created);
      }

      // 并发下"已存在"是正常路径（两个请求同时首次进入本周复盘）。
      const existing = await db
        .select()
        .from(reviews)
        .where(
          and(
            eq(reviews.userId, userId),
            eq(reviews.reviewType, 'weekly'),
            eq(reviews.periodKey, weekStart),
          ),
        )
        .limit(1);
      const row = existing[0];
      if (row === undefined) {
        throw new InvariantError({ message: '周复盘行在冲突分支中不存在' });
      }
      return toReview(row);
    },

    async materializeWeeklySnapshot(
      userId: string,
      weekStart: string,
      snapshot: WeeklySnapshot,
    ): Promise<Review> {
      const inserted = await db
        .insert(reviews)
        .values({
          userId,
          reviewType: 'weekly',
          periodKey: weekStart,
          snapshot,
          snapshotSchemaVersion: snapshot.schemaVersion,
        })
        .onConflictDoNothing({ target: [reviews.userId, reviews.reviewType, reviews.periodKey] })
        .returning();

      const created = inserted[0];
      if (created !== undefined) {
        return toReview(created);
      }

      const existing = await db
        .select()
        .from(reviews)
        .where(
          and(
            eq(reviews.userId, userId),
            eq(reviews.reviewType, 'weekly'),
            eq(reviews.periodKey, weekStart),
          ),
        )
        .limit(1);
      const row = existing[0];
      if (row === undefined) {
        throw new InvariantError({ message: '周复盘行在冲突分支中不存在' });
      }

      // 已有快照 → 写入后不变性，原样返回（不重算，DB §4.11.2）。
      if (row.snapshot !== null) {
        return toReview(row);
      }

      // 行存在但快照为空：本周做调整时先建了行（`ensureWeekly`），周结束后补写快照。
      const updated = await db
        .update(reviews)
        .set({
          snapshot,
          snapshotSchemaVersion: snapshot.schemaVersion,
          version: sql`${reviews.version} + 1`,
        })
        .where(
          and(eq(reviews.userId, userId), eq(reviews.id, row.id), eq(reviews.version, row.version)),
        )
        .returning();

      const written = updated[0];
      if (written === undefined) {
        throw new ConflictError('该周复盘刚刚在别处被修改，请重试');
      }
      return toReview(written);
    },

    async listAdjustments(userId: string, reviewId: string): Promise<readonly ReviewAdjustment[]> {
      const rows = await db
        .select()
        .from(reviewAdjustments)
        .where(and(eq(reviewAdjustments.userId, userId), eq(reviewAdjustments.reviewId, reviewId)))
        .orderBy(asc(reviewAdjustments.createdAt), asc(reviewAdjustments.id));

      return rows.map(toAdjustment);
    },
  };
}

export function createReviewAdjustmentApplier(db: Database): ReviewAdjustmentApplier {
  return {
    async apply(
      userId: string,
      input: ReviewAdjustmentCreateInput,
      write: AdjustmentWrite,
      expectedVersion: number | null,
    ): Promise<ReviewAdjustment> {
      return db.transaction(async (tx) => {
        if (write.kind === 'task') {
          const patch: Record<string, unknown> = { version: sql`${tasks.version} + 1` };
          if (write.estimatedMinutes !== undefined) {
            patch.estimatedMinutes = write.estimatedMinutes;
          }
          if (write.dueDate !== undefined) {
            patch.dueDate = write.dueDate;
          }
          if (write.softDelete === true) {
            // 经 `update()` 置 `deleted_at`，与既有软删口径一致（`updated_at` 前移）。
            patch.deletedAt = new Date();
          }

          const changed = await tx
            .update(tasks)
            .set(patch)
            .where(
              and(
                eq(tasks.userId, userId),
                eq(tasks.id, write.taskId),
                isNull(tasks.deletedAt),
                eq(tasks.version, expectedVersion ?? 0),
              ),
            )
            .returning();

          if (changed.length === 0) {
            const existing = await tx
              .select()
              .from(tasks)
              .where(and(eq(tasks.userId, userId), eq(tasks.id, write.taskId)))
              .limit(1);
            const row = existing[0];
            if (row === undefined || row.deletedAt !== null) {
              throw new NotFoundError('调整的任务不存在');
            }
            throw new ConflictError('任务已在别处被修改，请刷新后重试');
          }
        }

        if (write.kind === 'goal') {
          const changed = await tx
            .update(goals)
            .set({ status: write.status, version: sql`${goals.version} + 1` })
            .where(
              and(
                eq(goals.userId, userId),
                eq(goals.id, write.goalId),
                eq(goals.version, expectedVersion ?? 0),
              ),
            )
            .returning();

          if (changed.length === 0) {
            const existing = await tx
              .select()
              .from(goals)
              .where(and(eq(goals.userId, userId), eq(goals.id, write.goalId)))
              .limit(1);
            if (existing[0] === undefined) {
              throw new NotFoundError('调整的目标不存在');
            }
            throw new ConflictError('目标已在别处被修改，请刷新后重试');
          }
        }

        // 目标写入成功后才落记录——同一事务，任一失败都会整体回滚。
        const inserted = await tx
          .insert(reviewAdjustments)
          .values({
            userId,
            reviewId: input.reviewId,
            targetType: input.targetType,
            targetId: input.targetId,
            action: input.action,
            payload: input.payload,
          })
          .returning();

        const row = inserted[0];
        if (row === undefined) {
          throw new InvariantError({ message: '写入调整记录后数据库未返回记录' });
        }
        return toAdjustment(row);
      });
    },
  };
}
