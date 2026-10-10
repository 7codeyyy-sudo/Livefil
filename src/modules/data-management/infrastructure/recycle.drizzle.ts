/**
 * 回收区仓储（OPS-002，《接口文档》§13 回收区四端点）。
 *
 * 范围＝有 `deleted_at` 写入路径的五类：tasks / actions / routines /
 * fixed_commitments / expenses（《数据库设计》§4.18.1(3) 墓碑分类表；
 * routine_steps 随父级不单列）。全部查询带 userId 作用域（IAM-004）。
 *
 * ## 永久删除的两条前置防护
 *
 * 1. **自引用模板改挂**：`tasks.template_id` / `fixed_commitments.template_id`
 *    都是自引用 ON DELETE CASCADE——直接物理删模板行会**连带蒸发还活着的
 *    实例行**。删除前先把指向它的 `template_id` 置空（实例降级为独立行，
 *    数据不丢），再删本体。
 * 2. **级联的既定语义照单接受**：routine_steps 随例程、schedule_blocks 随
 *    任务/行动的级联是 schema 既定设计（子行的宿主已物理消失），不做额外保留。
 *
 * 「先备份纪律」的落地口径：每日备份（OPS-001）覆盖可恢复性 + 每次永久删除
 * 记 `DATA_DELETED` 安全事件留痕（RD-015 披露）。
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import {
  actions,
  fixedCommitments,
  expenses,
  routines,
  tasks,
} from '@/infrastructure/database/schema.ts';

import type { RecycleEntityType, RecycleItem, RecycleRepository } from '../domain/data-ports.ts';

/** 每类型一份「软删行的 id/名称/删除时间」投影（列白名单显式映射）。 */
export function createRecycleRepository(db: Database): RecycleRepository {
  return {
    async list(userId: string): Promise<readonly RecycleItem[]> {
      const [taskRows, actionRows, routineRows, commitmentRows, expenseRows] = await Promise.all([
        db
          .select({ id: tasks.id, name: tasks.title, deletedAt: tasks.deletedAt })
          .from(tasks)
          .where(and(eq(tasks.userId, userId), isNotNull(tasks.deletedAt))),
        db
          .select({ id: actions.id, name: actions.name, deletedAt: actions.deletedAt })
          .from(actions)
          .where(and(eq(actions.userId, userId), isNotNull(actions.deletedAt))),
        db
          .select({ id: routines.id, name: routines.name, deletedAt: routines.deletedAt })
          .from(routines)
          .where(and(eq(routines.userId, userId), isNotNull(routines.deletedAt))),
        db
          .select({
            id: fixedCommitments.id,
            name: fixedCommitments.title,
            deletedAt: fixedCommitments.deletedAt,
          })
          .from(fixedCommitments)
          .where(and(eq(fixedCommitments.userId, userId), isNotNull(fixedCommitments.deletedAt))),
        db
          .select({ id: expenses.id, name: expenses.note, deletedAt: expenses.deletedAt })
          .from(expenses)
          .where(and(eq(expenses.userId, userId), isNotNull(expenses.deletedAt))),
      ]);

      const items: RecycleItem[] = [];
      const push = (
        entityType: RecycleEntityType,
        rows: readonly { id: string; name: string | null; deletedAt: Date | null }[],
      ): void => {
        for (const row of rows) {
          if (row.deletedAt === null) {
            continue;
          }
          items.push({
            entityType,
            itemId: row.id,
            name: row.name ?? '',
            deletedAt: row.deletedAt,
          });
        }
      };
      push('task', taskRows);
      push('action', actionRows);
      push('routine', routineRows);
      push('fixed_commitment', commitmentRows);
      push('expense', expenseRows);
      return items;
    },

    async restore(userId, entityType, itemId, now): Promise<boolean> {
      if (entityType === 'task') {
        const rows = await db
          .update(tasks)
          .set({ deletedAt: null, version: sql`${tasks.version} + 1`, updatedAt: now })
          .where(and(eq(tasks.userId, userId), eq(tasks.id, itemId), isNotNull(tasks.deletedAt)))
          .returning({ id: tasks.id });
        return rows.length > 0;
      }
      if (entityType === 'action') {
        const rows = await db
          .update(actions)
          .set({ deletedAt: null, version: sql`${actions.version} + 1`, updatedAt: now })
          .where(
            and(eq(actions.userId, userId), eq(actions.id, itemId), isNotNull(actions.deletedAt)),
          )
          .returning({ id: actions.id });
        return rows.length > 0;
      }
      if (entityType === 'routine') {
        const rows = await db
          .update(routines)
          .set({ deletedAt: null, version: sql`${routines.version} + 1`, updatedAt: now })
          .where(
            and(
              eq(routines.userId, userId),
              eq(routines.id, itemId),
              isNotNull(routines.deletedAt),
            ),
          )
          .returning({ id: routines.id });
        return rows.length > 0;
      }
      if (entityType === 'fixed_commitment') {
        const rows = await db
          .update(fixedCommitments)
          .set({ deletedAt: null, version: sql`${fixedCommitments.version} + 1`, updatedAt: now })
          .where(
            and(
              eq(fixedCommitments.userId, userId),
              eq(fixedCommitments.id, itemId),
              isNotNull(fixedCommitments.deletedAt),
            ),
          )
          .returning({ id: fixedCommitments.id });
        return rows.length > 0;
      }
      const rows = await db
        .update(expenses)
        .set({ deletedAt: null, version: sql`${expenses.version} + 1`, updatedAt: now })
        .where(
          and(eq(expenses.userId, userId), eq(expenses.id, itemId), isNotNull(expenses.deletedAt)),
        )
        .returning({ id: expenses.id });
      return rows.length > 0;
    },

    async remove(userId, entityType, itemId): Promise<boolean> {
      if (entityType === 'task') {
        // 自引用模板改挂（文件头防护 1）：指向本行的模板引用先置空再删。
        await db
          .update(tasks)
          .set({ templateId: null })
          .where(and(eq(tasks.userId, userId), eq(tasks.templateId, itemId)));
        const rows = await db
          .delete(tasks)
          .where(and(eq(tasks.userId, userId), eq(tasks.id, itemId), isNotNull(tasks.deletedAt)))
          .returning({ id: tasks.id });
        return rows.length > 0;
      }
      if (entityType === 'fixed_commitment') {
        await db
          .update(fixedCommitments)
          .set({ templateId: null })
          .where(and(eq(fixedCommitments.userId, userId), eq(fixedCommitments.templateId, itemId)));
        const rows = await db
          .delete(fixedCommitments)
          .where(
            and(
              eq(fixedCommitments.userId, userId),
              eq(fixedCommitments.id, itemId),
              isNotNull(fixedCommitments.deletedAt),
            ),
          )
          .returning({ id: fixedCommitments.id });
        return rows.length > 0;
      }
      if (entityType === 'action') {
        const rows = await db
          .delete(actions)
          .where(
            and(eq(actions.userId, userId), eq(actions.id, itemId), isNotNull(actions.deletedAt)),
          )
          .returning({ id: actions.id });
        return rows.length > 0;
      }
      if (entityType === 'routine') {
        const rows = await db
          .delete(routines)
          .where(
            and(
              eq(routines.userId, userId),
              eq(routines.id, itemId),
              isNotNull(routines.deletedAt),
            ),
          )
          .returning({ id: routines.id });
        return rows.length > 0;
      }
      const rows = await db
        .delete(expenses)
        .where(
          and(eq(expenses.userId, userId), eq(expenses.id, itemId), isNotNull(expenses.deletedAt)),
        )
        .returning({ id: expenses.id });
      return rows.length > 0;
    },

    async clear(userId): Promise<number> {
      // 防护 1 的清空版：先收集「将被物理删除的模板行」，把还指向它们的
      // 实例行改挂（含活跃实例——模板进了回收区不代表它的实例也进了）。
      const [taskTemplates, commitmentTemplates] = await Promise.all([
        db
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(eq(tasks.userId, userId), isNotNull(tasks.deletedAt), isNotNull(tasks.templateId)),
          ),
        db
          .select({ id: fixedCommitments.id })
          .from(fixedCommitments)
          .where(
            and(
              eq(fixedCommitments.userId, userId),
              isNotNull(fixedCommitments.deletedAt),
              isNotNull(fixedCommitments.templateId),
            ),
          ),
      ]);
      const taskTemplateIds = taskTemplates.map((row) => row.id);
      const commitmentTemplateIds = commitmentTemplates.map((row) => row.id);
      if (taskTemplateIds.length > 0) {
        await db
          .update(tasks)
          .set({ templateId: null })
          .where(and(eq(tasks.userId, userId), inArray(tasks.templateId, taskTemplateIds)));
      }
      if (commitmentTemplateIds.length > 0) {
        await db
          .update(fixedCommitments)
          .set({ templateId: null })
          .where(
            and(
              eq(fixedCommitments.userId, userId),
              inArray(fixedCommitments.templateId, commitmentTemplateIds),
            ),
          );
      }

      const [taskRows, actionRows, routineRows, commitmentRows, expenseRows] = await Promise.all([
        db
          .delete(tasks)
          .where(and(eq(tasks.userId, userId), isNotNull(tasks.deletedAt)))
          .returning({ id: tasks.id }),
        db
          .delete(actions)
          .where(and(eq(actions.userId, userId), isNotNull(actions.deletedAt)))
          .returning({ id: actions.id }),
        db
          .delete(routines)
          .where(and(eq(routines.userId, userId), isNotNull(routines.deletedAt)))
          .returning({ id: routines.id }),
        db
          .delete(fixedCommitments)
          .where(and(eq(fixedCommitments.userId, userId), isNotNull(fixedCommitments.deletedAt)))
          .returning({ id: fixedCommitments.id }),
        db
          .delete(expenses)
          .where(and(eq(expenses.userId, userId), isNotNull(expenses.deletedAt)))
          .returning({ id: expenses.id }),
      ]);
      return (
        taskRows.length +
        actionRows.length +
        routineRows.length +
        commitmentRows.length +
        expenseRows.length
      );
    },
  };
}
