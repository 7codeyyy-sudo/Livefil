/**
 * 例程仓储 Drizzle 实现（DB §4.7）。
 *
 * 步骤集合 diff（接口 §8 PATCH 冻结语义）：带 id 更新、缺 id 新增、缺失软删，
 * 全部在**同一事务**里重排 position 为 0..n 连续——分步写会出现"中间态
 * position 冲突"，唯一索引会把合法的交换挡下来。
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import {
  routineSteps,
  routines,
  type RoutineRow,
  type RoutineStepRow,
} from '@/infrastructure/database/schema.ts';
import { ConflictError, NotFoundError } from '@/shared/errors/app-error.ts';

import type { RecurrenceRule } from '../../scheduling/domain/recurrence';
import {
  type Routine,
  type RoutineCreateInput,
  type RoutineDetail,
  type RoutinePatch,
  type RoutineStep,
  type RoutineStepPatch,
} from '../domain/routine';
import type { RoutineRepository } from '../domain/routine-repository';

function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    userId: row.userId,
    lifeAreaId: row.lifeAreaId,
    name: row.name,
    // rule 的结构校验在写入侧已收口；读出时按原样携带（解析在消费方做）。
    recurrenceRule: row.recurrenceRule as RecurrenceRule,
    anchorTime: row.anchorTime,
    timezone: row.timezone,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

function toStep(row: RoutineStepRow): RoutineStep {
  return {
    id: row.id,
    userId: row.userId,
    routineId: row.routineId,
    title: row.title,
    position: row.position,
    estimatedMinutes: row.estimatedMinutes,
    minimumVersion: row.minimumVersion,
    version: row.version,
  };
}

export function createRoutineRepository(db: Database) {
  return {
    async findDetail(userId: string, routineId: string): Promise<RoutineDetail | null> {
      const rows = await db
        .select()
        .from(routines)
        .where(
          and(eq(routines.userId, userId), eq(routines.id, routineId), isNull(routines.deletedAt)),
        )
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const steps = await db
        .select()
        .from(routineSteps)
        .where(
          and(
            eq(routineSteps.routineId, routineId),
            eq(routineSteps.userId, userId),
            isNull(routineSteps.deletedAt),
          ),
        )
        .orderBy(asc(routineSteps.position));
      return { routine: toRoutine(row), steps: steps.map(toStep) };
    },

    async listAll(userId: string): Promise<readonly RoutineDetail[]> {
      const routineRows = await db
        .select()
        .from(routines)
        .where(and(eq(routines.userId, userId), isNull(routines.deletedAt)))
        .orderBy(asc(routines.name), asc(routines.id));
      const details: RoutineDetail[] = [];
      for (const row of routineRows) {
        const detail = await this.findDetail(userId, row.id);
        if (detail !== null) {
          details.push(detail);
        }
      }
      return details;
    },

    async create(userId: string, input: RoutineCreateInput): Promise<RoutineDetail> {
      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(routines)
          .values({
            userId,
            name: input.name,
            lifeAreaId: input.lifeAreaId,
            recurrenceRule: input.recurrenceRule,
            anchorTime: input.anchorTime,
            timezone: input.timezone,
          })
          .returning();
        const routineRow = inserted[0];
        if (routineRow === undefined) {
          throw new ConflictError('例程创建失败');
        }
        const stepRows = await tx
          .insert(routineSteps)
          .values(
            input.steps.map((step, position) => ({
              userId,
              routineId: routineRow.id,
              title: step.title,
              position,
              estimatedMinutes: step.estimatedMinutes,
              minimumVersion: step.minimumVersion,
            })),
          )
          .returning();
        return { routine: toRoutine(routineRow), steps: stepRows.map(toStep) };
      });
    },

    async update(
      userId: string,
      routineId: string,
      expectedVersion: number,
      patch: RoutinePatch,
      steps: readonly RoutineStepPatch[],
    ): Promise<RoutineDetail> {
      return db.transaction(async (tx) => {
        const currentRows = await tx
          .select()
          .from(routines)
          .where(
            and(
              eq(routines.userId, userId),
              eq(routines.id, routineId),
              isNull(routines.deletedAt),
            ),
          )
          .limit(1)
          .for('update');
        const current = currentRows[0];
        if (current === undefined) {
          throw new NotFoundError('例程不存在');
        }
        if (current.version !== expectedVersion) {
          throw new ConflictError('例程已被其他修改更新，请刷新后重试');
        }

        const written = await tx
          .update(routines)
          // @user-scope-exempt: 归属已由上方 for update 的 select 校验
          .set({
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.lifeAreaId === undefined ? {} : { lifeAreaId: patch.lifeAreaId }),
            ...(patch.recurrenceRule === undefined ? {} : { recurrenceRule: patch.recurrenceRule }),
            ...(patch.anchorTime === undefined ? {} : { anchorTime: patch.anchorTime }),
            ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
            version: expectedVersion + 1,
          })
          .where(eq(routines.id, routineId))
          .returning();
        const routineRow = written[0];
        if (routineRow === undefined) {
          throw new NotFoundError('例程不存在');
        }

        const existingRows = await tx
          .select()
          .from(routineSteps)
          .where(
            and(
              eq(routineSteps.routineId, routineId),
              eq(routineSteps.userId, userId),
              isNull(routineSteps.deletedAt),
            ),
          )
          .orderBy(asc(routineSteps.position));
        const existingById = new Map(existingRows.map((row) => [row.id, row]));

        // diff 三分支：更新（带 id）/ 新增（缺 id）/ 软删（输入里缺失的既有行）。
        const keptIds = new Set<string>();
        for (const step of steps) {
          if (step.id !== undefined) {
            if (!existingById.has(step.id)) {
              throw new NotFoundError('例程步骤不存在');
            }
            keptIds.add(step.id);
          }
        }
        for (const row of existingRows) {
          if (!keptIds.has(row.id)) {
            await tx
              .update(routineSteps)
              .set({ deletedAt: new Date(), version: sql`${routineSteps.version} + 1` })
              .where(and(eq(routineSteps.id, row.id), eq(routineSteps.userId, userId)));
          }
        }

        const finalRows: RoutineStepRow[] = [];
        let position = 0;
        for (const step of steps) {
          if (step.id === undefined) {
            const inserted = await tx
              .insert(routineSteps)
              .values({
                userId,
                routineId,
                title: step.title ?? '',
                position,
                estimatedMinutes: step.estimatedMinutes ?? null,
                minimumVersion: step.minimumVersion ?? null,
              })
              .returning();
            const insertedRow = inserted[0];
            if (insertedRow === undefined) {
              throw new ConflictError('例程步骤写入失败');
            }
            finalRows.push(insertedRow);
          } else {
            const updated = await tx
              .update(routineSteps)
              // @user-scope-exempt: 归属经例程行校验
              .set({
                ...(step.title === undefined ? {} : { title: step.title }),
                ...(step.estimatedMinutes === undefined
                  ? {}
                  : { estimatedMinutes: step.estimatedMinutes }),
                ...(step.minimumVersion === undefined
                  ? {}
                  : { minimumVersion: step.minimumVersion }),
                position,
                version: sql`${routineSteps.version} + 1`,
              })
              .where(and(eq(routineSteps.id, step.id), eq(routineSteps.userId, userId)))
              .returning();
            const updatedRow = updated[0];
            if (updatedRow === undefined) {
              throw new NotFoundError('例程步骤不存在');
            }
            finalRows.push(updatedRow);
          }
          position += 1;
        }

        return {
          routine: toRoutine(routineRow),
          steps: finalRows.map(toStep).sort((a, b) => a.position - b.position),
        };
      });
    },

    async softDelete(userId: string, routineId: string): Promise<boolean> {
      const detail = await this.findDetail(userId, routineId);
      if (detail === null) {
        return false;
      }
      await db
        .update(routines)
        .set({ deletedAt: new Date(), version: detail.routine.version + 1 })
        .where(and(eq(routines.id, routineId), eq(routines.userId, userId)));
      return true;
    },
  } satisfies RoutineRepository;
}
