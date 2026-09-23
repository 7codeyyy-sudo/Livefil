/**
 * 固定事项仓储 Drizzle 实现（SCHED-002 / DB §4.16）。
 *
 * 三形态同表：单次（rule/template 均空）、模板（rule 非空）、实例（template_id
 * 非空）。列表查询只回实例行（模板行没有 UTC 时刻），模板经 listTemplates 专取。
 */
import { and, asc, desc, eq, gte, isNotNull, isNull, lt } from 'drizzle-orm';
import { calendarDayOf } from '../domain/zoned-time.ts';

import type { Database } from '@/infrastructure/database/client.ts';
import { fixedCommitments, type FixedCommitmentRow } from '@/infrastructure/database/schema.ts';
import { ConflictError, NotFoundError } from '@/shared/errors/app-error.ts';

import type { FixedCommitment } from '../domain/schedule-block.ts';
import type {
  FixedCommitmentCreateInput,
  FixedCommitmentPatch,
  FixedCommitmentRepository,
} from '../domain/fixed-commitment-repository.ts';

function toCommitment(row: FixedCommitmentRow): FixedCommitment {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    templateId: row.templateId,
    localDate: row.localDate,
    startsAtUtc: row.startsAtUtc,
    endsAtUtc: row.endsAtUtc,
    startsAtLocal: row.startsAtLocal,
    durationMinutes: row.durationMinutes,
    timezone: row.timezone,
    recurrenceRule: row.recurrenceRule,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

export function createFixedCommitmentRepository(db: Database) {
  return {
    async findById(userId: string, id: string): Promise<FixedCommitment | null> {
      const rows = await db
        .select()
        .from(fixedCommitments)
        .where(and(eq(fixedCommitments.userId, userId), eq(fixedCommitments.id, id)))
        .limit(1);
      return rows[0] === undefined ? null : toCommitment(rows[0]);
    },

    async listInstancesOverlapping(
      userId: string,
      windowStartUtc: Date,
      windowEndUtc: Date,
    ): Promise<readonly FixedCommitment[]> {
      const rows = await db
        .select()
        .from(fixedCommitments)
        .where(
          and(
            eq(fixedCommitments.userId, userId),
            isNull(fixedCommitments.deletedAt),
            isNotNull(fixedCommitments.startsAtUtc),
            lt(fixedCommitments.startsAtUtc, windowEndUtc),
            gte(fixedCommitments.endsAtUtc, windowStartUtc),
          ),
        )
        .orderBy(asc(fixedCommitments.startsAtUtc), asc(fixedCommitments.id));
      return rows.map(toCommitment);
    },

    async listTemplates(userId: string): Promise<readonly FixedCommitment[]> {
      const rows = await db
        .select()
        .from(fixedCommitments)
        .where(
          and(
            eq(fixedCommitments.userId, userId),
            isNull(fixedCommitments.deletedAt),
            isNotNull(fixedCommitments.recurrenceRule),
          ),
        )
        .orderBy(desc(fixedCommitments.createdAt));
      return rows.map(toCommitment);
    },

    async findByTemplateAndDate(
      userId: string,
      templateId: string,
      localDate: string,
    ): Promise<FixedCommitment | null> {
      const rows = await db
        .select()
        .from(fixedCommitments)
        .where(
          and(
            eq(fixedCommitments.userId, userId),
            eq(fixedCommitments.templateId, templateId),
            eq(fixedCommitments.localDate, localDate),
          ),
        )
        .limit(1);
      return rows[0] === undefined ? null : toCommitment(rows[0]);
    },

    async create(userId: string, input: FixedCommitmentCreateInput): Promise<FixedCommitment> {
      const rows = await db
        .insert(fixedCommitments)
        .values({ userId, ...input })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new ConflictError('固定事项创建失败');
      }
      return toCommitment(row);
    },

    async update(
      userId: string,
      id: string,
      expectedVersion: number,
      patch: FixedCommitmentPatch,
    ): Promise<FixedCommitment> {
      const current = await this.findById(userId, id);
      if (current === null || current.deletedAt !== null) {
        throw new NotFoundError('固定事项不存在');
      }
      if (current.version !== expectedVersion) {
        throw new ConflictError('固定事项已被其他修改更新，请刷新后重试');
      }
      // 实例行时间被移动后重算归属日历日（§4.16：local_date 跟随实例）。
      const nextLocalDate =
        current.recurrenceRule === null &&
        current.templateId === null &&
        patch.startsAtUtc !== undefined &&
        patch.timezone !== undefined
          ? calendarDayOf(patch.startsAtUtc, patch.timezone)
          : undefined;
      const written = await db
        .update(fixedCommitments)
        // @user-scope-exempt: 归属已由上方 findById 按 userId 校验
        .set({
          ...(nextLocalDate === undefined ? {} : { localDate: nextLocalDate }),
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.startsAtUtc === undefined ? {} : { startsAtUtc: patch.startsAtUtc }),
          ...(patch.endsAtUtc === undefined ? {} : { endsAtUtc: patch.endsAtUtc }),
          ...(patch.startsAtLocal === undefined ? {} : { startsAtLocal: patch.startsAtLocal }),
          ...(patch.durationMinutes === undefined
            ? {}
            : { durationMinutes: patch.durationMinutes }),
          ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
          ...(patch.recurrenceRule === undefined ? {} : { recurrenceRule: patch.recurrenceRule }),
          version: expectedVersion + 1,
        })
        .where(and(eq(fixedCommitments.id, id), eq(fixedCommitments.userId, userId)))
        .returning();
      const row = written[0];
      if (row === undefined) {
        throw new NotFoundError('固定事项不存在');
      }
      return toCommitment(row);
    },

    async softDelete(userId: string, id: string): Promise<boolean> {
      const current = await this.findById(userId, id);
      if (current === null || current.deletedAt !== null) {
        return false;
      }
      await db
        .update(fixedCommitments)
        .set({ deletedAt: new Date(), version: current.version + 1 })
        .where(and(eq(fixedCommitments.id, id), eq(fixedCommitments.userId, userId)));
      return true;
    },
  } satisfies FixedCommitmentRepository;
}
