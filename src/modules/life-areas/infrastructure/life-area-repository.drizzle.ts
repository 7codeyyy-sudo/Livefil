/**
 * 生活领域仓储的 Drizzle 实现（DB-001 / IAM-003）。
 *
 * 与用户仓储同样的三层职责：行↔实体映射、事务边界、数据库错误 → 领域错误。
 */
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import { lifeAreas, type LifeAreaRow } from '@/infrastructure/database/schema.ts';
import { ConflictError, InvariantError, NotFoundError } from '@/shared/errors/app-error.ts';
import { hasPostgresErrorCode } from '@/shared/errors/postgres-error.ts';

import {
  assertReorderCoversActiveSet,
  isLifeAreaColorKey,
  type LifeArea,
  type LifeAreaCreateInput,
  type LifeAreaPatch,
} from '../domain/life-area.ts';
import type { LifeAreaRepository, ListLifeAreasOptions } from '../domain/life-area-repository.ts';

/** PostgreSQL 的唯一约束冲突。 */
const UNIQUE_VIOLATION = '23505';

/** 行 → 领域实体。`color_key` 若不是已知 key（有人绕过应用写库），明确报错而不是放行。 */
function toLifeArea(row: LifeAreaRow): LifeArea {
  if (!isLifeAreaColorKey(row.colorKey)) {
    throw new InvariantError({ message: 'life_areas.color_key 的取值不在契约集合内' });
  }
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    colorKey: row.colorKey,
    sortOrder: row.sortOrder,
    isDefault: row.isDefault,
    isArchived: row.isArchived,
    version: row.version,
  };
}

/**
 * 把唯一约束冲突翻译成领域冲突错误。
 *
 * 名称唯一性**不靠预检**（先 SELECT 再 INSERT）：两步之间存在窗口，并发或重试
 * 都能让它失效；而库里的部分唯一索引（`WHERE is_archived = false`）是原子的。
 * 索引唯一，索引之外的一切都是尽力而为。
 */
function rethrowNameConflict(error: unknown, name: string): never {
  if (hasPostgresErrorCode(error, UNIQUE_VIOLATION)) {
    throw new ConflictError(`已存在同名的未归档领域：${name}`);
  }
  throw error;
}

export function createLifeAreaRepository(db: Database): LifeAreaRepository {
  /** 该用户当前全部未归档领域（仓储内部使用）。 */
  async function listActive(tx: Database, userId: string): Promise<readonly LifeArea[]> {
    const rows = await tx
      .select()
      .from(lifeAreas)
      .where(and(eq(lifeAreas.userId, userId), eq(lifeAreas.isArchived, false)))
      .orderBy(lifeAreas.sortOrder);
    return rows.map(toLifeArea);
  }

  return {
    async listByUser(userId: string, options: ListLifeAreasOptions): Promise<readonly LifeArea[]> {
      const rows = await db
        .select()
        .from(lifeAreas)
        .where(
          options.includeArchived
            ? eq(lifeAreas.userId, userId)
            : and(eq(lifeAreas.userId, userId), eq(lifeAreas.isArchived, false)),
        )
        .orderBy(lifeAreas.sortOrder);
      return rows.map(toLifeArea);
    },

    async findById(userId: string, lifeAreaId: string): Promise<LifeArea | null> {
      const rows = await db
        .select()
        .from(lifeAreas)
        // 作用域与 id 一起进 WHERE：少了 userId 就是一个"猜 id 就能读到别人数据"的入口。
        .where(and(eq(lifeAreas.userId, userId), eq(lifeAreas.id, lifeAreaId)))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toLifeArea(row);
    },

    async create(userId: string, input: LifeAreaCreateInput): Promise<LifeArea> {
      try {
        return await db.transaction(async (tx) => {
          // 新领域排到末位。`COALESCE(MAX, -1) + 1` 让空列表时的首项为 0，
          // 与默认播种的起点一致；用 COUNT 会在删/归档后产生重复序号。
          const nextOrder = await tx
            .select({ value: sql<number>`COALESCE(MAX(${lifeAreas.sortOrder}), -1) + 1` })
            .from(lifeAreas)
            .where(eq(lifeAreas.userId, userId));

          const sortOrder = Number(nextOrder[0]?.value ?? 0);

          const inserted = await tx
            .insert(lifeAreas)
            .values({
              userId,
              name: input.name,
              colorKey: input.colorKey,
              sortOrder,
              isDefault: false,
            })
            .returning();

          const row = inserted[0];
          if (row === undefined) {
            throw new InvariantError({ message: '创建生活领域后数据库未返回记录' });
          }
          return toLifeArea(row);
        });
      } catch (error) {
        rethrowNameConflict(error, input.name);
      }
    },

    async update(userId: string, lifeAreaId: string, patch: LifeAreaPatch): Promise<LifeArea> {
      try {
        const updated = await db
          .update(lifeAreas)
          .set({ ...patch, version: sql`${lifeAreas.version} + 1` })
          .where(and(eq(lifeAreas.userId, userId), eq(lifeAreas.id, lifeAreaId)))
          .returning();

        const row = updated[0];
        if (row === undefined) {
          // 作用域不匹配与"记录不存在"都走这里，且**返回同一个错误**：
          // 调用方无法区分二者，因此"猜 id"既不能读到也不能推断出别人的数据
          // （§4.8「非本人 id 按 NOT_FOUND 处理，不泄露存在性」）。
          throw new NotFoundError('生活领域不存在');
        }
        return toLifeArea(row);
      } catch (error) {
        rethrowNameConflict(error, patch.name ?? '（重命名）');
      }
    },

    async reorderActive(
      userId: string,
      orderedIds: readonly string[],
    ): Promise<readonly LifeArea[]> {
      return db.transaction(async (tx) => {
        // 校验与写入必须同事务：分开做的话，两次 reorder 之间列表变了，
        // 就会按一份过期的集合去重排。
        const active = await listActive(tx, userId);
        assertReorderCoversActiveSet(
          active.map((area) => area.id),
          orderedIds,
        );

        // 逐条 UPDATE 而不是一条 CASE 语句：领域数是个位数，可读性与
        // 「顺序即 index」的直白对应更值钱；单语句优化等真的成为瓶颈再说。
        for (const [index, lifeAreaId] of orderedIds.entries()) {
          await tx
            .update(lifeAreas)
            .set({ sortOrder: index, version: sql`${lifeAreas.version} + 1` })
            .where(and(eq(lifeAreas.userId, userId), eq(lifeAreas.id, lifeAreaId)));
        }

        return listActive(tx, userId);
      });
    },
  };
}
