/**
 * 开销仓储的 Drizzle 实现（EXP-001）。
 *
 * 三层职责与前几个仓储相同：行↔实体映射、事务边界、数据库错误 → 领域错误。
 * 三条贯穿全文件的纪律：
 *
 * - **已软删不出现在任何查询**（接口文档 §9）——每个 SELECT 都带 `deleted_at is null`；
 * - **金额在边界上转 `bigint`**——写入经 `parseAmountMinor()`，回读经
 *   `formatAmountMinor()`，全文件不出现 `Number()`；
 * - **排序键固定 `occurred_on desc, created_at desc`**（不开放排序参数），游标是
 *   `(occurred_on, created_at, id)` 的不透明编码——同一毫秒可能有多行，
 *   只用时间做游标会跳行。
 */
import { and, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import {
  expenseCategories,
  expenses,
  goals,
  lifeAreas,
  type ExpenseRow,
  type NewExpenseRow,
} from '@/infrastructure/database/schema.ts';
import { ConflictError, InvariantError, NotFoundError } from '@/shared/errors/app-error.ts';

import {
  formatAmountMinor,
  isExpenseSource,
  parseAmountMinor,
  type Expense,
  type ExpenseCreateInput,
  type ExpensePatch,
} from '../domain/expense.ts';
import type {
  ExpensePage,
  ExpenseRepository,
  ExpenseSummary,
  ExpenseSummaryOptions,
  ExpenseSummaryTotals,
  ListExpensesOptions,
} from '../domain/expense-repository.ts';

/** 行 → 领域实体。来源若不是已知枚举（有人绕过应用写库），明确报错而不是放行。 */
function toExpense(row: ExpenseRow): Expense {
  if (!isExpenseSource(row.source)) {
    throw new InvariantError({ message: 'expenses.source 的取值不在契约集合内' });
  }
  return {
    id: row.id,
    userId: row.userId,
    categoryId: row.categoryId,
    lifeAreaId: row.lifeAreaId,
    goalId: row.goalId,
    actionId: row.actionId,
    // 驱动以 bigint 回读，`.toString()` 是无损的；`Number()` 会丢精度。
    amountMinor: formatAmountMinor(row.amountMinor),
    currencyCode: row.currencyCode,
    occurredOn: row.occurredOn,
    paymentMethod: row.paymentMethod,
    note: row.note,
    source: row.source,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

/** 游标编码：`(occurred_on, created_at, id)` 的 base64——对客户端不透明，对实现可解码。 */
function encodeCursor(row: ExpenseRow): string {
  return Buffer.from(
    JSON.stringify({ o: row.occurredOn, c: row.createdAt.toISOString(), i: row.id }),
  ).toString('base64url');
}

function decodeCursor(
  cursor: string,
): { readonly occurredOn: string; readonly time: Date; readonly id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      o?: unknown;
      c?: unknown;
      i?: unknown;
    };
    if (
      typeof parsed.o !== 'string' ||
      typeof parsed.c !== 'string' ||
      typeof parsed.i !== 'string'
    ) {
      return null;
    }
    const time = new Date(parsed.c);
    if (Number.isNaN(time.getTime())) {
      return null;
    }
    return { occurredOn: parsed.o, time, id: parsed.i };
  } catch {
    return null;
  }
}

/** 累加器：金额以 `bigint` 相加——字符串只是载体，绝不参与算术。 */
interface TotalsAccumulator {
  readonly totalMinor: bigint;
  readonly count: number;
}

function addToTotals(
  bucket: Map<string, TotalsAccumulator>,
  currencyCode: string,
  totalMinor: string,
  count: number,
): void {
  const current = bucket.get(currencyCode);
  bucket.set(currencyCode, {
    totalMinor: (current?.totalMinor ?? 0n) + BigInt(totalMinor),
    count: (current?.count ?? 0) + count,
  });
}

/** 累加器 → 响应形状：按币种升序，金额转字符串（不回退到 `Number()`）。 */
function toTotals(bucket: Map<string, TotalsAccumulator>): readonly ExpenseSummaryTotals[] {
  return [...bucket.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([currencyCode, value]) => ({
      currencyCode,
      totalMinor: value.totalMinor.toString(),
      count: value.count,
    }));
}

/** 摘要查询的行形状（`SUM(...)::bigint` 与 `COUNT(*)` 都由驱动以字符串回读）。 */
interface ExpenseSummaryRow {
  readonly key: string | null;
  readonly label: string;
  readonly currencyCode: string;
  readonly totalMinor: string;
  readonly count: string;
}

/** 未关联分组在 Map 里的占位键（真实 uuid 永不等于空串，不会撞车）。 */
const UNLINKED_BUCKET_KEY = '';

export function createExpenseRepository(db: Database): ExpenseRepository {
  /** 所有查询共用的"未软删"谓词。 */
  const notDeleted = isNull(expenses.deletedAt);

  return {
    async findById(userId: string, expenseId: string): Promise<Expense | null> {
      const rows = await db
        .select()
        .from(expenses)
        .where(and(eq(expenses.userId, userId), eq(expenses.id, expenseId), notDeleted))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toExpense(row);
    },

    async list(userId: string, options: ListExpensesOptions): Promise<ExpensePage> {
      // 作用域谓词**直接写在 where 里**（而不是混进数组），这样"每条查询都带 userId"
      // 是可以被静态读出来的事实，不依赖阅读者去追数组首项（IAM-004 断言的口径）。
      const filters: SQL[] = [notDeleted];
      if (options.from !== undefined) {
        // `occurred_on` 是 date 列，日历日字符串可直接比较。
        filters.push(sql`${expenses.occurredOn} >= ${options.from}`);
      }
      if (options.to !== undefined) {
        filters.push(sql`${expenses.occurredOn} <= ${options.to}`);
      }
      if (options.categoryId !== undefined) {
        filters.push(eq(expenses.categoryId, options.categoryId));
      }
      if (options.lifeAreaId !== undefined) {
        filters.push(eq(expenses.lifeAreaId, options.lifeAreaId));
      }
      if (options.goalId !== undefined) {
        // 单列过滤：经行动关联的开销也带着父目标（披露 D），无需 JOIN `actions`。
        filters.push(eq(expenses.goalId, options.goalId));
      }

      const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
      if (cursor !== null) {
        // 行值比较：三列同步降序，因此整体小于游标即"下一页"，同毫秒多行不会互相跳过。
        filters.push(
          sql`(${expenses.occurredOn}, ${expenses.createdAt}, ${expenses.id}) < (${cursor.occurredOn}, ${cursor.time}, ${cursor.id})`,
        );
      }

      const rows = await db
        .select()
        .from(expenses)
        .where(and(eq(expenses.userId, userId), ...filters))
        .orderBy(desc(expenses.occurredOn), desc(expenses.createdAt), desc(expenses.id))
        .limit(options.limit + 1);

      const hasMore = rows.length > options.limit;
      const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
      const last = pageRows[pageRows.length - 1];
      return {
        items: pageRows.map(toExpense),
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
        hasMore,
      };
    },

    async create(userId: string, input: ExpenseCreateInput): Promise<Expense> {
      const rows = await db
        .insert(expenses)
        .values({
          userId,
          categoryId: input.categoryId,
          lifeAreaId: input.lifeAreaId,
          goalId: input.goalId,
          actionId: input.actionId,
          amountMinor: parseAmountMinor(input.amountMinor),
          currencyCode: input.currencyCode,
          occurredOn: input.occurredOn,
          paymentMethod: input.paymentMethod,
          note: input.note,
          source: input.source,
        })
        .returning();

      const row = rows[0];
      if (row === undefined) {
        throw new InvariantError({ message: '创建开销后数据库未返回记录' });
      }
      return toExpense(row);
    },

    async update(
      userId: string,
      expenseId: string,
      expectedVersion: number,
      patch: ExpensePatch,
    ): Promise<Expense> {
      const updates: Partial<NewExpenseRow> = {};
      if (patch.categoryId !== undefined) {
        updates.categoryId = patch.categoryId;
      }
      // 可空字段用 `!== undefined` 判定：`null` 是"解除关联"这个真实意图，必须写入。
      if (patch.lifeAreaId !== undefined) {
        updates.lifeAreaId = patch.lifeAreaId;
      }
      if (patch.goalId !== undefined) {
        updates.goalId = patch.goalId;
      }
      if (patch.actionId !== undefined) {
        updates.actionId = patch.actionId;
      }
      if (patch.amountMinor !== undefined) {
        updates.amountMinor = parseAmountMinor(patch.amountMinor);
      }
      if (patch.currencyCode !== undefined) {
        updates.currencyCode = patch.currencyCode;
      }
      if (patch.occurredOn !== undefined) {
        updates.occurredOn = patch.occurredOn;
      }
      if (patch.paymentMethod !== undefined) {
        updates.paymentMethod = patch.paymentMethod;
      }
      if (patch.note !== undefined) {
        updates.note = patch.note;
      }
      if (patch.source !== undefined) {
        updates.source = patch.source;
      }

      // 版本递增与「WHERE version = 期望值」在同一条语句里完成（公共字段的既定纪律）。
      const changed = await db
        .update(expenses)
        .set({ ...updates, version: sql`${expenses.version} + 1` })
        .where(
          and(
            eq(expenses.userId, userId),
            eq(expenses.id, expenseId),
            notDeleted,
            eq(expenses.version, expectedVersion),
          ),
        )
        .returning();

      const row = changed[0];
      if (row !== undefined) {
        return toExpense(row);
      }

      // 区分"不存在/已软删"与"版本冲突"：两者给调用方的语义不同（404 vs 409）。
      const existing = await this.findById(userId, expenseId);
      if (existing === null) {
        throw new NotFoundError('开销不存在');
      }
      throw new ConflictError('开销已在别处被修改，请刷新后重试');
    },

    async softDelete(userId: string, expenseId: string): Promise<Expense | null> {
      // 经 `update()` 而非裸 SQL：`updated_at` 的前移是同步链路
      // `changeAt = coalesce(updated_at, created_at)` 能看见这次删除的前提。
      const rows = await db
        .update(expenses)
        .set({ deletedAt: new Date(), version: sql`${expenses.version} + 1` })
        .where(and(eq(expenses.userId, userId), eq(expenses.id, expenseId), notDeleted))
        .returning();
      const row = rows[0];
      return row === undefined ? null : toExpense(row);
    },

    async restore(userId: string, expenseId: string, expectedVersion: number): Promise<Expense> {
      const rows = await db
        .update(expenses)
        .set({ deletedAt: null, version: sql`${expenses.version} + 1` })
        .where(
          and(
            eq(expenses.userId, userId),
            eq(expenses.id, expenseId),
            // 只有"已软删"的行可以被撤销恢复，本接口不是通用的"复活一切"入口。
            isNotNull(expenses.deletedAt),
            eq(expenses.version, expectedVersion),
          ),
        )
        .returning();

      const row = rows[0];
      if (row !== undefined) {
        return toExpense(row);
      }

      // 三种情形要分开报：不存在 / 未被删除（404）与版本过期（409）。
      const existing = await db
        .select()
        .from(expenses)
        .where(and(eq(expenses.userId, userId), eq(expenses.id, expenseId)))
        .limit(1);

      const current = existing[0];
      if (current === undefined || current.deletedAt === null) {
        throw new NotFoundError('开销不存在或未被删除');
      }
      throw new ConflictError('开销已在别处被修改，请刷新后重试');
    },

    async summarize(userId: string, options: ExpenseSummaryOptions): Promise<ExpenseSummary> {
      const filters: SQL[] = [notDeleted];
      if (options.from !== undefined) {
        filters.push(sql`${expenses.occurredOn} >= ${options.from}`);
      }
      if (options.to !== undefined) {
        filters.push(sql`${expenses.occurredOn} <= ${options.to}`);
      }

      // 每个分支都是"按分组键 + 币种"的一次聚合：`SUM(...)::bigint` 让结果以整数字符串
      // 回读（不经 JS number），`COUNT(*)` 的字符串回读在下面用 `Number()` 收口——
      // 计数是行数，不可能触及 2^53。
      const totals = {
        currencyCode: expenses.currencyCode,
        totalMinor: sql<string>`SUM(${expenses.amountMinor})::bigint`,
        count: sql<string>`COUNT(*)`,
      };

      let rows: readonly ExpenseSummaryRow[];
      if (options.groupBy === 'category') {
        rows = await db
          .select({ key: expenses.categoryId, label: expenseCategories.name, ...totals })
          .from(expenses)
          // 分类是 NOT NULL，用 inner join；标签按分类的展示顺序排（FR-051 的固定顺序）。
          .innerJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
          .where(and(eq(expenses.userId, userId), ...filters))
          .groupBy(expenses.categoryId, expenseCategories.name, expenseCategories.sortOrder)
          .orderBy(expenseCategories.sortOrder, expenseCategories.name);
      } else if (options.groupBy === 'lifeArea') {
        rows = await db
          .select({
            key: expenses.lifeAreaId,
            label: sql<string>`COALESCE(${lifeAreas.name}, '未关联')`,
            ...totals,
          })
          .from(expenses)
          // left join：未关联的开销归入「未关联」组，而不是从汇总里消失——
          // 后者会让分组之和与总计对不上，而"总计"是用户最常看的那一行。
          .leftJoin(lifeAreas, eq(expenses.lifeAreaId, lifeAreas.id))
          .where(and(eq(expenses.userId, userId), ...filters))
          .groupBy(expenses.lifeAreaId, lifeAreas.name)
          .orderBy(sql`COALESCE(${lifeAreas.name}, '未关联')`);
      } else {
        rows = await db
          .select({
            key: expenses.goalId,
            label: sql<string>`COALESCE(${goals.name}, '未关联')`,
            ...totals,
          })
          .from(expenses)
          // `groupBy=goal` 按 `goal_id` 单列分组：经行动关联的开销也带着父目标
          // （披露 D），因此这里**不需要 JOIN `actions`**，join `goals` 只为取标签。
          .leftJoin(goals, eq(expenses.goalId, goals.id))
          .where(and(eq(expenses.userId, userId), ...filters))
          .groupBy(expenses.goalId, goals.name)
          .orderBy(sql`COALESCE(${goals.name}, '未关联')`);
      }

      // Map 的插入顺序即 SQL 的排序结果，因此分组顺序由查询决定，无需二次排序。
      const groups = new Map<
        string,
        {
          readonly key: string | null;
          readonly label: string;
          readonly totals: Map<string, TotalsAccumulator>;
        }
      >();
      const grandTotals = new Map<string, TotalsAccumulator>();

      for (const row of rows) {
        const bucketKey = row.key ?? UNLINKED_BUCKET_KEY;
        const group = groups.get(bucketKey) ?? {
          key: row.key,
          label: row.label,
          totals: new Map<string, TotalsAccumulator>(),
        };
        addToTotals(group.totals, row.currencyCode, row.totalMinor, Number(row.count));
        groups.set(bucketKey, group);
        addToTotals(grandTotals, row.currencyCode, row.totalMinor, Number(row.count));
      }

      return {
        groups: [...groups.values()].map((group) => ({
          key: group.key,
          label: group.label,
          totals: toTotals(group.totals),
        })),
        grandTotals: toTotals(grandTotals),
      };
    },
  };
}
