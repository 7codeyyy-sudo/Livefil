/**
 * 任务仓储的 Drizzle 实现（TASK-001）。
 *
 * 与 life-areas 仓储同样的三层职责：行↔实体映射、事务边界、数据库错误 → 领域错误。
 * 两条贯穿全文件的纪律：
 * - **软删不出现在任何查询**（接口文档 §4）——每个 SELECT 都带 `deleted_at IS NULL`；
 * - **排序键固定 `created_at desc`**（同上，不开放排序参数），游标是
 *   `(created_at, id)` 的不透明编码——同一毫秒可能有多行，只用时间做游标会跳行。
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import { scheduleBlocks, tasks, type TaskRow } from '@/infrastructure/database/schema.ts';
import { ConflictError, NotFoundError, ValidationError } from '@/shared/errors/app-error.ts';

import { assertTaskTransition, TASK_STATUSES, type Task, type TaskStatus } from '../domain/task.ts';
import type { TaskRepository } from '../domain/task-repository.ts';

function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

/** 行 → 领域实体。状态若不是已知枚举（有人绕过应用写库），明确报错而不是放行。 */
function toTask(row: TaskRow): Task {
  if (!isTaskStatus(row.status)) {
    throw new Error(`tasks.status 的取值不在契约集合内：${row.status}`);
  }
  return {
    id: row.id,
    userId: row.userId,
    lifeAreaId: row.lifeAreaId,
    goalId: row.goalId,
    actionId: row.actionId,
    title: row.title,
    status: row.status,
    estimatedMinutes: row.estimatedMinutes,
    minimumVersion: row.minimumVersion,
    dueDate: row.dueDate,
    recurrenceRule: row.recurrenceRule,
    source: row.source as Task['source'],
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

/** 游标编码：`(created_at, id)` 的 base64——对客户端不透明，对实现可解码。 */
function encodeCursor(row: TaskRow): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { readonly time: Date; readonly id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      c?: unknown;
      i?: unknown;
    };
    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string') {
      return null;
    }
    const time = new Date(parsed.c);
    if (Number.isNaN(time.getTime())) {
      return null;
    }
    return { time, id: parsed.i };
  } catch {
    return null;
  }
}

export function createTaskRepository(db: Database): TaskRepository {
  /** 所有查询共用的"未删除"谓词——软删任务不出现在任何查询中。 */
  const notDeleted = isNull(tasks.deletedAt);

  return {
    async findById(userId, taskId) {
      const rows = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId), notDeleted))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toTask(row);
    },

    async list(userId, options) {
      const conditions = [eq(tasks.userId, userId), notDeleted];
      if (options.status !== undefined) {
        conditions.push(eq(tasks.status, options.status));
      }
      if (options.lifeAreaId !== undefined) {
        conditions.push(eq(tasks.lifeAreaId, options.lifeAreaId));
      }
      if (options.goalId !== undefined) {
        conditions.push(eq(tasks.goalId, options.goalId));
      }
      // from/to 是日历日边界（YYYY-MM-DD）。`due_date` 是 date 列，字符串可直接比较。
      if (options.from !== undefined) {
        conditions.push(sql`${tasks.dueDate} >= ${options.from}`);
      }
      if (options.to !== undefined) {
        conditions.push(sql`${tasks.dueDate} <= ${options.to}`);
      }

      const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
      if (cursor !== null) {
        // 行值比较：`(created_at, id)` 整体小于游标——同毫秒多行不会互相跳过。
        conditions.push(sql`(${tasks.createdAt}, ${tasks.id}) < (${cursor.time}, ${cursor.id})`);
      }

      const rows = await db
        .select()
        .from(tasks)
        // @user-scope-exempt: 作用域谓词在 conditions 数组首项，恒为 eq(tasks.userId, userId)
        .where(and(...conditions))
        // 排序键固定 createdAt desc（接口文档 §4，不开放排序参数）；
        // id 做平局裁决，保证同毫秒内的顺序稳定。
        .orderBy(desc(tasks.createdAt), desc(tasks.id))
        .limit(options.limit + 1);

      const hasMore = rows.length > options.limit;
      const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
      const last = pageRows[pageRows.length - 1];
      return {
        items: pageRows.map(toTask),
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
        hasMore,
      };
    },

    async create(userId, input) {
      const rows = await db
        .insert(tasks)
        .values({
          userId,
          title: input.title,
          status: input.status,
          lifeAreaId: input.lifeAreaId,
          dueDate: input.dueDate,
          estimatedMinutes: input.estimatedMinutes,
          minimumVersion: input.minimumVersion,
          goalId: input.goalId,
          actionId: input.actionId,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error('任务创建后未能读回');
      }
      return toTask(row);
    },

    async update(userId, taskId, expectedVersion, patch) {
      const updates: Partial<TaskRow> = {};
      if (patch.title !== undefined) {
        updates.title = patch.title;
      }
      if (patch.lifeAreaId !== undefined) {
        updates.lifeAreaId = patch.lifeAreaId;
      }
      if (patch.dueDate !== undefined) {
        updates.dueDate = patch.dueDate;
      }
      if (patch.estimatedMinutes !== undefined) {
        updates.estimatedMinutes = patch.estimatedMinutes;
      }
      if (patch.minimumVersion !== undefined) {
        updates.minimumVersion = patch.minimumVersion;
      }
      if (patch.goalId !== undefined) {
        updates.goalId = patch.goalId;
      }
      if (patch.actionId !== undefined) {
        updates.actionId = patch.actionId;
      }

      // 版本递增与「WHERE version = 期望值」在同一条语句里完成（公共字段的既定纪律）。
      const rows = await db
        .update(tasks)
        .set({ ...updates, version: sql`${tasks.version} + 1` })
        .where(
          and(
            eq(tasks.userId, userId),
            eq(tasks.id, taskId),
            notDeleted,
            eq(tasks.version, expectedVersion),
          ),
        )
        .returning();
      const row = rows[0];
      if (row === undefined) {
        // 区分"不存在/已删"与"版本冲突"：两者给调用方的语义不同（404 vs 409）。
        const existing = await this.findById(userId, taskId);
        if (existing === null) {
          throw new NotFoundError('任务不存在');
        }
        throw new ConflictError('任务已在别处被修改，请刷新后重试');
      }
      return toTask(row);
    },

    async updateStatus(userId, taskId, to) {
      // 流转合法性是领域规则：先读现态、判定，再写。判定收口在 domain 的矩阵上。
      const current = await this.findById(userId, taskId);
      if (current === null) {
        throw new NotFoundError('任务不存在');
      }
      assertTaskTransition(current.status, to);

      const rows = await db
        .update(tasks)
        .set({ status: to, version: sql`${tasks.version} + 1` })
        .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId), notDeleted))
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError('任务不存在');
      }
      return toTask(row);
    },

    async softDelete(userId, taskId) {
      const rows = await db
        .update(tasks)
        .set({ deletedAt: new Date(), version: sql`${tasks.version} + 1` })
        .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId), notDeleted))
        .returning();
      return rows.length > 0;
    },

    async batchApply(userId, taskIds, operation, options) {
      // 单事务整批：任一条不合法 → 抛错回滚，不产生部分写入（接口文档 §4）。
      return db.transaction(async (tx) => {
        const updated: Task[] = [];
        for (const taskId of taskIds) {
          const rows = await tx
            .select()
            .from(tasks)
            .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId), isNull(tasks.deletedAt)))
            .limit(1)
            .for('update');
          const row = rows[0];
          if (row === undefined) {
            throw new NotFoundError('任务不存在');
          }
          const current = toTask(row);
          const target: TaskStatus = operation === 'archive' ? 'archived' : 'planned';
          // 批量与单条走同一张流转表——"批量"不是绕过状态机的后门。
          assertTaskTransition(current.status, target);

          const patch: Record<string, unknown> = {
            status: target,
            version: sql`${tasks.version} + 1`,
          };
          if (operation === 'schedule') {
            if (options.dueDate !== null) {
              patch.dueDate = options.dueDate;
            }
            if (options.lifeAreaId !== null) {
              patch.lifeAreaId = options.lifeAreaId;
            }
          }

          // @user-scope-exempt: 归属与流转合法性已在上方 for update 的 select 中按 userId 校验
          const written = await tx.update(tasks).set(patch).where(eq(tasks.id, taskId)).returning();
          const next = written[0];
          if (next === undefined) {
            throw new NotFoundError('任务不存在');
          }
          updated.push(toTask(next));
        }
        return updated;
      });
    },
    async attachAction(userId, taskId, links) {
      // 单事务：状态前置校验（必须仍是收件箱）与三列回填同时生效，
      // 中间不存在"已关联但未安排"的中间态。
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId), notDeleted))
          .limit(1)
          .for('update');
        const row = rows[0];
        if (row === undefined) {
          throw new NotFoundError('任务不存在');
        }
        if (row.status !== 'inbox') {
          throw new ValidationError('只有收件箱中的任务可以转为目标行动');
        }

        const written = await tx
          .update(tasks)
          // @user-scope-exempt: 归属已在上方 for update 的 select 中按 userId 校验
          .set({
            goalId: links.goalId,
            actionId: links.actionId,
            status: 'planned',
            version: sql`${tasks.version} + 1`,
          })
          .where(eq(tasks.id, taskId))
          .returning();
        const next = written[0];
        if (next === undefined) {
          throw new NotFoundError('任务不存在');
        }
        return toTask(next);
      });
    },

    /* ---- Phase 4：重复任务物化 ---- */

    async listRecurringTemplates(userId) {
      const rows = await db
        .select()
        .from(tasks)
        // 实例行的 recurrence_rule 为 NULL，`is not null` 同时过滤掉它们。
        .where(and(eq(tasks.userId, userId), notDeleted, isNotNull(tasks.recurrenceRule)))
        .orderBy(asc(tasks.createdAt));
      return rows.map(toTask);
    },

    async findByTemplateAndDate(userId, templateId, dueDate) {
      const rows = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.userId, userId),
            eq(tasks.templateId, templateId),
            eq(tasks.dueDate, dueDate),
          ),
        )
        .limit(1);
      return rows[0] === undefined ? null : toTask(rows[0]);
    },

    async createRecurrenceInstance(userId, template, dueDate) {
      const inserted = await db
        .insert(tasks)
        .values({
          userId,
          templateId: template.id,
          lifeAreaId: template.lifeAreaId,
          goalId: template.goalId,
          actionId: template.actionId,
          title: template.title,
          // 冻结口径：实例 planned、rule 置 null、source='recurrence'，
          // 其余字段继承模板（实例＝当时的字段快照）。
          status: 'planned',
          estimatedMinutes: template.estimatedMinutes,
          minimumVersion: template.minimumVersion,
          dueDate,
          recurrenceRule: null,
          source: 'recurrence',
        })
        .onConflictDoNothing()
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        // 并发展开撞了唯一约束：幂等语义，回读既有实例。
        const existing = await this.findByTemplateAndDate(userId, template.id, dueDate);
        if (existing === null) {
          throw new ConflictError('重复任务实例创建冲突');
        }
        return existing;
      }
      return toTask(row);
    },

    async listUnscheduledOn(userId, date, limit) {
      const rows = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.userId, userId),
            eq(tasks.status, 'planned'),
            notDeleted,
            isNotNull(tasks.dueDate),
            // 含过期：due ≤ date 正是要把拖期任务浮上来（FR-030 overdue 标记）。
            lte(tasks.dueDate, date),
            // 当日已有未取消时间块的不算"未安排"。
            sql`not exists (select 1 from ${scheduleBlocks} sb where sb.task_id = ${tasks.id} and sb.status <> 'cancelled')`,
          ),
        )
        .orderBy(asc(tasks.dueDate), asc(tasks.createdAt))
        .limit(limit);
      return rows.map(toTask);
    },

    async findByIds(userId, ids) {
      if (ids.length === 0) {
        return [];
      }
      const rows = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.userId, userId), inArray(tasks.id, [...ids]), notDeleted));
      return rows.map(toTask);
    },
  } satisfies TaskRepository;
}
