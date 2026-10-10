/**
 * 导入网关（OPS-002，《接口文档》§13 preview 体检 + confirm 两个写入模式）。
 *
 * ## 行处置与 schema 现实的对照（RD-015 披露的实现裁量）
 *
 * - **可回收三类**（tasks/routines/expenses，有 `deleted_at`）：replace 把
 *   陈旧行软删进回收区、文件行按 id 覆盖写——契约字面。
 * - **无删除语义三类**（goals/execution_logs/reviews，《数据库设计》§4.18.3/4：
 *   无删除路径 + 同步链墓碑缺失）：replace **按 id 覆盖写、陈旧行原样保留**——
 *   schema 支撑不了契约那句「软删进回收区」，物理清场又会在同步链上产生
 *   无法投递的删除（复活缺陷）。与总监「删除区不做」同一处置哲学：
 *   不建 schema 诚实支撑不了的破坏性路径，差异如实披露。
 * - **设置**：merge 恒跳过（singleton 已存在）；replace 以文件字段覆盖
 *   （字段级缺失保留现值）。
 *
 * ## 判重与幂等
 *
 * merge 按实体 id——**软删行也算已存在**（行在 ⇒ 重复，计入跳过；数据留在
 * 回收区可另行恢复），同文件重复导入第二次全跳过（自然幂等）；replace 的
 * 计数映射＝added 插入（含复活）/ skipped 覆盖写 / cleared 软删进回收区
 * （随 RD-015 披露）。幂等键（Idempotency-Key）在路由层编排，不在本层。
 *
 * ## 引用修复（文件来自异地环境时的必然动作）
 *
 * 悬空引用一律回落 null（tasks/expenses 的 goal/action/lifeArea/taskId/…）；
 * 例外两处：`expenses.category_id` NOT NULL——分类不在 FR-090 导出范围，
 * 按「同 id → 默认分类 → 最小排序活跃分类」回落（文件不含分类名，同名匹配
 * 不可行）；`routine_steps.position` 的唯一性由部分索引（迁移 0009）保证
 * 软删行不占位。
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import {
  actions,
  executionLogs,
  expenseCategories,
  expenses,
  goals,
  lifeAreas,
  reviewAdjustments,
  reviews,
  routineSteps,
  routines,
  scheduleBlocks,
  tasks,
  users,
} from '@/infrastructure/database/schema.ts';
import { ValidationError } from '@/shared/errors/app-error.ts';

import type { ExportEntity, ExportFile, ExportSettings } from '../domain/export-format.ts';
import type {
  ImportGateway,
  ImportInspection,
  ImportOutcome,
  ImportTypeCount,
} from '../domain/data-ports.ts';

// `ExportFile` 仍被两处写入模式与 inspect 的签名使用（仅 collectExisting 收窄）。

/** 事务句柄与库句柄共用同一套查询 API（帮助函数两处复用）。 */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type DbLike = Database | Tx;

/** 预取的既有状态：判重集合 + 引用修复集合。全部按 userId 作用域读出。 */
interface ExistingState {
  /** 全量 id（含软删行）——merge 的「已存在」判据（行在即重复）。 */
  readonly allTaskIds: ReadonlySet<string>;
  readonly allRoutineIds: ReadonlySet<string>;
  readonly allExpenseIds: ReadonlySet<string>;
  readonly activeTaskIds: ReadonlySet<string>;
  readonly activeGoalIds: ReadonlySet<string>;
  readonly activeLogIds: ReadonlySet<string>;
  readonly activeRoutineIds: ReadonlySet<string>;
  readonly activeExpenseIds: ReadonlySet<string>;
  readonly activeReviewIds: ReadonlySet<string>;
  readonly lifeAreaIds: ReadonlySet<string>;
  readonly actionIds: ReadonlySet<string>;
  readonly scheduleBlockIds: ReadonlySet<string>;
  readonly categories: readonly CategoryRow[];
}

interface CategoryRow {
  readonly id: string;
  readonly isDefault: boolean;
  readonly isArchived: boolean;
  readonly sortOrder: number;
}

/** 去重保序（畸形文件里的重复 id 只按首见处理，避免 PK 冲突）。 */
function uniqueById(entities: readonly ExportEntity[]): {
  readonly list: readonly ExportEntity[];
  readonly ids: ReadonlySet<string>;
} {
  const seen = new Set<string>();
  const list: ExportEntity[] = [];
  for (const entity of entities) {
    if (seen.has(entity.id)) {
      continue;
    }
    seen.add(entity.id);
    list.push(entity);
  }
  return { list, ids: seen };
}

/**
 * NOT NULL 文本列取值：类型上恒为 `string`（满足插入类型），运行期的
 * `undefined` 由「drizzle 跳过未定义列 → DB 默认值或 NOT NULL 报错」兜底
 * ——缺列的文件要么有默认值可依、要么整笔回滚，不静默造空值。
 */
function req(value: unknown): string {
  return value as string;
}

function nullableText(value: unknown): string | null {
  return value === undefined || value === null ? null : (value as string);
}

function intOrNull(value: unknown): number | null {
  return value === undefined || value === null ? null : (value as number);
}

/** ISO 字符串 → Date（缺失给 null；坏值给 Invalid Date——由 DB 约束兜底回滚）。 */
function requiredDate(value: unknown): Date {
  return new Date(String(value));
}

function nullableJson(value: unknown): unknown {
  return value === undefined || value === null ? null : value;
}

/** 更新集剔除 undefined（不依赖 drizzle 对 undefined 的二阶行为）。 */
function prune<T extends object>(values: T): T {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as T;
}

/** 悬空引用回落 null（文件缺失或目标不在本环境）。 */
function resolveRef(value: unknown, valid: ReadonlySet<string>): string | null {
  if (typeof value === 'string' && valid.has(value)) {
    return value;
  }
  return null;
}

/** 分类回落链（分类不在 FR-090 导出范围的必然适配，见文件头）。 */
function resolveCategory(value: unknown, categories: readonly CategoryRow[]): string {
  if (typeof value === 'string') {
    const exact = categories.find((category) => category.id === value);
    if (exact !== undefined) {
      return exact.id;
    }
  }
  const active = categories.filter((category) => !category.isArchived);
  const preferred = active.length === 0 ? categories : active;
  if (preferred.length === 0) {
    // 可达性：用户创建时必播种默认分类——走到这里说明库被绕过应用清空了。
    throw new ValidationError('当前环境没有支出分类，无法导入开销数据');
  }
  const sorted = [...preferred].sort((a, b) => {
    if (a.isDefault !== b.isDefault) {
      return a.isDefault ? -1 : 1;
    }
    return a.sortOrder - b.sortOrder;
  });
  const picked = sorted[0];
  if (picked === undefined) {
    throw new ValidationError('当前环境没有支出分类，无法导入开销数据');
  }
  return picked.id;
}

async function collectExisting(db: DbLike, userId: string): Promise<ExistingState> {
  const [
    taskRows,
    goalRows,
    logRows,
    routineRows,
    expenseRows,
    reviewRows,
    lifeRows,
    actionRows,
    blockRows,
    categoryRows,
  ] = await Promise.all([
    db.select({ id: tasks.id }).from(tasks).where(eq(tasks.userId, userId)),
    db.select({ id: goals.id }).from(goals).where(eq(goals.userId, userId)),
    db.select({ id: executionLogs.id }).from(executionLogs).where(eq(executionLogs.userId, userId)),
    db.select({ id: routines.id }).from(routines).where(eq(routines.userId, userId)),
    db.select({ id: expenses.id }).from(expenses).where(eq(expenses.userId, userId)),
    db.select({ id: reviews.id }).from(reviews).where(eq(reviews.userId, userId)),
    db.select({ id: lifeAreas.id }).from(lifeAreas).where(eq(lifeAreas.userId, userId)),
    db
      .select({ id: actions.id })
      .from(actions)
      .where(and(eq(actions.userId, userId), isNull(actions.deletedAt))),
    db
      .select({ id: scheduleBlocks.id })
      .from(scheduleBlocks)
      .where(eq(scheduleBlocks.userId, userId)),
    db
      .select({
        id: expenseCategories.id,
        isDefault: expenseCategories.isDefault,
        isArchived: expenseCategories.isArchived,
        sortOrder: expenseCategories.sortOrder,
      })
      .from(expenseCategories)
      .where(eq(expenseCategories.userId, userId)),
  ]);

  const activeTask = new Set<string>();
  const allTask = new Set<string>();
  const [deletedTaskRows, deletedRoutineRows, deletedExpenseRows] = await Promise.all([
    db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), sql`${tasks.deletedAt} is not null`)),
    db
      .select({ id: routines.id })
      .from(routines)
      .where(and(eq(routines.userId, userId), sql`${routines.deletedAt} is not null`)),
    db
      .select({ id: expenses.id })
      .from(expenses)
      .where(and(eq(expenses.userId, userId), sql`${expenses.deletedAt} is not null`)),
  ]);
  for (const row of taskRows) {
    allTask.add(row.id);
    activeTask.add(row.id);
  }
  for (const row of deletedTaskRows) {
    allTask.add(row.id);
  }
  const activeRoutine = new Set<string>();
  const allRoutine = new Set<string>();
  for (const row of routineRows) {
    allRoutine.add(row.id);
    activeRoutine.add(row.id);
  }
  for (const row of deletedRoutineRows) {
    allRoutine.add(row.id);
  }
  const activeExpense = new Set<string>();
  const allExpense = new Set<string>();
  for (const row of expenseRows) {
    allExpense.add(row.id);
    activeExpense.add(row.id);
  }
  for (const row of deletedExpenseRows) {
    allExpense.add(row.id);
  }

  return {
    allTaskIds: allTask,
    allRoutineIds: allRoutine,
    allExpenseIds: allExpense,
    activeTaskIds: activeTask,
    activeGoalIds: new Set(goalRows.map((row) => row.id)),
    activeLogIds: new Set(logRows.map((row) => row.id)),
    activeRoutineIds: activeRoutine,
    activeExpenseIds: activeExpense,
    activeReviewIds: new Set(reviewRows.map((row) => row.id)),
    lifeAreaIds: new Set(lifeRows.map((row) => row.id)),
    actionIds: new Set(actionRows.map((row) => row.id)),
    scheduleBlockIds: new Set(blockRows.map((row) => row.id)),
    categories: categoryRows,
  };
}

/** 计数器（confirm 响应的三个数）。 */
interface Counters {
  added: number;
  skipped: number;
  cleared: number;
}

function countFor(fileIds: ReadonlySet<string>, existingIds: ReadonlySet<string>): ImportTypeCount {
  let repeated = 0;
  for (const id of fileIds) {
    if (existingIds.has(id)) {
      repeated += 1;
    }
  }
  return { total: fileIds.size, 新增: fileIds.size - repeated, 重复: repeated };
}

/* ------------------------------------------------------------------ */
/* 行映射（列白名单——未知键丢弃，缺列由 DB 约束兜底回滚）              */
/* ------------------------------------------------------------------ */

function taskValues(
  userId: string,
  entity: ExportEntity,
  state: ExistingState,
  validGoals: ReadonlySet<string>,
  validTasks: ReadonlySet<string>,
) {
  return {
    id: entity.id,
    userId,
    lifeAreaId: resolveRef(entity['lifeAreaId'], state.lifeAreaIds),
    goalId: resolveRef(entity['goalId'], validGoals),
    actionId: resolveRef(entity['actionId'], state.actionIds),
    title: req(entity['title']),
    status: req(entity['status']),
    estimatedMinutes: intOrNull(entity['estimatedMinutes']),
    minimumVersion: nullableText(entity['minimumVersion']),
    dueDate: nullableText(entity['dueDate']),
    recurrenceRule: nullableJson(entity['recurrenceRule']),
    templateId: resolveRef(entity['templateId'], validTasks),
    source: req(entity['source']),
    createdAt: requiredDate(entity['createdAt']),
    updatedAt: requiredDate(entity['updatedAt']),
  };
}

function goalValues(userId: string, entity: ExportEntity, state: ExistingState) {
  return {
    id: entity.id,
    userId,
    lifeAreaId: resolveRef(entity['lifeAreaId'], state.lifeAreaIds),
    name: req(entity['name']),
    reason: nullableText(entity['reason']),
    status: req(entity['status']),
    startDate: nullableText(entity['startDate']),
    targetDate: nullableText(entity['targetDate']),
    resultMetric: nullableJson(entity['resultMetric']),
    createdAt: requiredDate(entity['createdAt']),
    updatedAt: requiredDate(entity['updatedAt']),
  };
}

function logValues(
  userId: string,
  entity: ExportEntity,
  state: ExistingState,
  validTasks: ReadonlySet<string>,
) {
  return {
    id: entity.id,
    userId,
    taskId: resolveRef(entity['taskId'], validTasks),
    actionId: resolveRef(entity['actionId'], state.actionIds),
    scheduleBlockId: resolveRef(entity['scheduleBlockId'], state.scheduleBlockIds),
    status: req(entity['status']),
    plannedMinutes: intOrNull(entity['plannedMinutes']),
    actualMinutes: intOrNull(entity['actualMinutes']),
    reasonCode: nullableText(entity['reasonCode']),
    note: nullableText(entity['note']),
    energyLevel: nullableText(entity['energyLevel']),
    moodScore: intOrNull(entity['moodScore']),
    occurredAt: requiredDate(entity['occurredAt']),
    createdAt: requiredDate(entity['createdAt']),
  };
}

function routineValues(userId: string, entity: ExportEntity, state: ExistingState) {
  return {
    id: entity.id,
    userId,
    lifeAreaId: resolveRef(entity['lifeAreaId'], state.lifeAreaIds),
    name: req(entity['name']),
    recurrenceRule: entity['recurrenceRule'],
    anchorTime: nullableText(entity['anchorTime']),
    timezone: req(entity['timezone']),
    createdAt: requiredDate(entity['createdAt']),
    updatedAt: requiredDate(entity['updatedAt']),
  };
}

function stepValues(userId: string, routineId: string, entity: ExportEntity) {
  return {
    id: entity.id,
    userId,
    routineId,
    title: req(entity['title']),
    position: entity['position'] as number,
    estimatedMinutes: intOrNull(entity['estimatedMinutes']),
    minimumVersion: nullableText(entity['minimumVersion']),
    createdAt: requiredDate(entity['createdAt']),
    updatedAt: requiredDate(entity['updatedAt']),
  };
}

function expenseValues(
  userId: string,
  entity: ExportEntity,
  state: ExistingState,
  validGoals: ReadonlySet<string>,
) {
  return {
    id: entity.id,
    userId,
    categoryId: resolveCategory(entity['categoryId'], state.categories),
    lifeAreaId: resolveRef(entity['lifeAreaId'], state.lifeAreaIds),
    goalId: resolveRef(entity['goalId'], validGoals),
    actionId: resolveRef(entity['actionId'], state.actionIds),
    amountMinor: BigInt(String(entity['amountMinor'] ?? '')),
    currencyCode: req(entity['currencyCode']),
    occurredOn: req(entity['occurredOn']),
    paymentMethod: nullableText(entity['paymentMethod']),
    note: nullableText(entity['note']),
    source: req(entity['source']),
    createdAt: requiredDate(entity['createdAt']),
    updatedAt: requiredDate(entity['updatedAt']),
  };
}

function reviewValues(userId: string, entity: ExportEntity) {
  return {
    id: entity.id,
    userId,
    reviewType: req(entity['reviewType']),
    periodKey: req(entity['periodKey']),
    answers: nullableJson(entity['answers']),
    energyLevel: nullableText(entity['energyLevel']),
    snapshot: nullableJson(entity['snapshot']),
    snapshotSchemaVersion: intOrNull(entity['snapshotSchemaVersion']),
    createdAt: requiredDate(entity['createdAt']),
    updatedAt: requiredDate(entity['updatedAt']),
  };
}

function adjustmentValues(userId: string, reviewId: string, entity: ExportEntity) {
  return {
    id: entity.id,
    userId,
    reviewId,
    targetType: req(entity['targetType']),
    targetId: req(entity['targetId']),
    action: req(entity['action']),
    payload: entity['payload'] ?? {},
    createdAt: requiredDate(entity['createdAt']),
  };
}

/** 设置字段的更新集（只取文件给出且同型的字段——解析层已过滤）。 */
function settingsUpdate(settings: ExportSettings, now: Date) {
  return prune({
    displayName: settings.displayName,
    locale: settings.locale,
    timezone: settings.timezone,
    currencyCode: settings.currencyCode,
    weekStartsOn: settings.weekStartsOn,
    defaultTaskDurationMinutes: settings.defaultTaskDurationMinutes,
    defaultBufferMinutes: settings.defaultBufferMinutes,
    aiEnabled: settings.aiEnabled,
    aiDataConsent: settings.aiDataConsent,
    reminderEnabled: settings.reminderEnabled,
    quietHoursStart: settings.quietHoursStart,
    quietHoursEnd: settings.quietHoursEnd,
    version: sql`${users.version} + 1`,
    updatedAt: now,
  });
}

/* ------------------------------------------------------------------ */
/* 引用集合与计数（merge/replace 共用）                                 */
/* ------------------------------------------------------------------ */

function referenceSets(
  state: ExistingState,
  file: ExportFile,
): {
  readonly validGoals: ReadonlySet<string>;
  readonly validTasks: ReadonlySet<string>;
} {
  const validGoals = new Set(state.activeGoalIds);
  const validTasks = new Set(state.activeTaskIds);
  for (const goal of file.goals) {
    validGoals.add(goal.id);
  }
  for (const task of file.tasks) {
    validTasks.add(task.id);
  }
  return { validGoals, validTasks };
}

/* ------------------------------------------------------------------ */
/* 网关                                                                 */
/* ------------------------------------------------------------------ */

export function createImportGateway(db: Database): ImportGateway {
  return {
    async inspect(userId: string, file: ExportFile): Promise<ImportInspection> {
      const state = await collectExisting(db, userId);
      const fileTasks = uniqueById(file.tasks);
      const fileGoals = uniqueById(file.goals);
      const fileLogs = uniqueById(file.executionLogs);
      const fileRoutines = uniqueById(file.routines);
      const fileExpenses = uniqueById(file.expenses);
      const fileReviews = uniqueById(file.reviews);

      // willClear＝replace 实际会进回收区的陈旧行（可回收三类的活跃存量 − 文件）。
      const willClear =
        countStale(state.activeTaskIds, fileTasks.ids) +
        countStale(state.activeRoutineIds, fileRoutines.ids) +
        countStale(state.activeExpenseIds, fileExpenses.ids);

      return {
        counts: {
          tasks: countFor(fileTasks.ids, state.allTaskIds),
          goals: countFor(fileGoals.ids, state.activeGoalIds),
          executionLogs: countFor(fileLogs.ids, state.activeLogIds),
          routines: countFor(fileRoutines.ids, state.allRoutineIds),
          expenses: countFor(fileExpenses.ids, state.allExpenseIds),
          reviews: countFor(fileReviews.ids, state.activeReviewIds),
          settings:
            file.settings === null
              ? { total: 0, 新增: 0, 重复: 0 }
              : { total: 1, 新增: 0, 重复: 1 },
        },
        willClear,
      };
    },

    async merge(userId: string, file: ExportFile): Promise<ImportOutcome> {
      const outcome = await db.transaction(async (tx): Promise<Counters> => {
        const state = await collectExisting(tx, userId);
        const { validGoals, validTasks } = referenceSets(state, file);
        const counters: Counters = { added: 0, skipped: 0, cleared: 0 };

        // 顺序＝外键依赖：goals → tasks → routines(+steps) → logs → expenses
        // → reviews(+adjustments) → settings。
        for (const goal of uniqueById(file.goals).list) {
          if (state.activeGoalIds.has(goal.id)) {
            counters.skipped += 1;
            continue;
          }
          await tx.insert(goals).values(goalValues(userId, goal, state));
          counters.added += 1;
        }
        for (const task of uniqueById(file.tasks).list) {
          if (state.allTaskIds.has(task.id)) {
            counters.skipped += 1;
            continue;
          }
          await tx.insert(tasks).values(taskValues(userId, task, state, validGoals, validTasks));
          counters.added += 1;
        }
        for (const routine of uniqueById(file.routines).list as readonly (ExportEntity & {
          steps?: readonly ExportEntity[];
        })[]) {
          if (state.allRoutineIds.has(routine.id)) {
            counters.skipped += 1;
            continue;
          }
          await tx.insert(routines).values(routineValues(userId, routine, state));
          for (const step of routine.steps ?? []) {
            await tx.insert(routineSteps).values(stepValues(userId, routine.id, step));
          }
          counters.added += 1;
        }
        for (const log of uniqueById(file.executionLogs).list) {
          if (state.activeLogIds.has(log.id)) {
            counters.skipped += 1;
            continue;
          }
          await tx.insert(executionLogs).values(logValues(userId, log, state, validTasks));
          counters.added += 1;
        }
        for (const expense of uniqueById(file.expenses).list) {
          if (state.allExpenseIds.has(expense.id)) {
            counters.skipped += 1;
            continue;
          }
          await tx.insert(expenses).values(expenseValues(userId, expense, state, validGoals));
          counters.added += 1;
        }
        for (const review of uniqueById(file.reviews).list as readonly (ExportEntity & {
          adjustments?: readonly ExportEntity[];
        })[]) {
          if (state.activeReviewIds.has(review.id)) {
            counters.skipped += 1;
            continue;
          }
          await tx.insert(reviews).values(reviewValues(userId, review));
          for (const adjustment of review.adjustments ?? []) {
            await tx
              .insert(reviewAdjustments)
              .values(adjustmentValues(userId, review.id, adjustment));
          }
          counters.added += 1;
        }
        if (file.settings !== null) {
          // merge 判重按「已存在 ⇒ 跳过」：设置 singleton 恒存在 ⇒ 恒重复。
          counters.skipped += 1;
        }
        return counters;
      });
      return { added: outcome.added, skipped: outcome.skipped, cleared: 0 };
    },

    async replace(userId: string, file: ExportFile, now: Date): Promise<ImportOutcome> {
      return db.transaction(async (tx): Promise<ImportOutcome> => {
        const state = await collectExisting(tx, userId);
        const { validGoals, validTasks } = referenceSets(state, file);
        const counters: Counters = { added: 0, skipped: 0, cleared: 0 };
        const fileTaskIdSet = uniqueById(file.tasks).ids;
        const fileRoutineIdSet = uniqueById(file.routines).ids;
        const fileExpenseIdSet = uniqueById(file.expenses).ids;

        /* ---- goals：覆盖写，陈旧行保留（无删除语义，见文件头） ---- */
        for (const goal of uniqueById(file.goals).list) {
          if (state.activeGoalIds.has(goal.id)) {
            await tx
              .update(goals)
              .set(
                prune({
                  ...goalValues(userId, goal, state),
                  version: sql`${goals.version} + 1`,
                  updatedAt: now,
                }),
              )
              .where(and(eq(goals.userId, userId), eq(goals.id, goal.id)));
            counters.skipped += 1;
            continue;
          }
          await tx.insert(goals).values(goalValues(userId, goal, state));
          counters.added += 1;
        }

        /* ---- tasks：陈旧软删进回收区（先删后写，避免同 id 的复活歧义） ---- */
        const staleTasks = [...state.activeTaskIds].filter((id) => !fileTaskIdSet.has(id));
        if (staleTasks.length > 0) {
          await tx
            .update(tasks)
            .set({ deletedAt: now, version: sql`${tasks.version} + 1`, updatedAt: now })
            .where(and(eq(tasks.userId, userId), inArray(tasks.id, staleTasks)));
          counters.cleared += staleTasks.length;
        }
        for (const task of uniqueById(file.tasks).list) {
          if (state.activeTaskIds.has(task.id)) {
            await tx
              .update(tasks)
              .set(
                prune({
                  ...taskValues(userId, task, state, validGoals, validTasks),
                  deletedAt: null,
                  version: sql`${tasks.version} + 1`,
                  updatedAt: now,
                }),
              )
              .where(and(eq(tasks.userId, userId), eq(tasks.id, task.id)));
            counters.skipped += 1;
            continue;
          }
          if (state.allTaskIds.has(task.id)) {
            // 文件里的 id 在目标库里处于软删态：复活（覆盖写语义下数据要回来）。
            await tx
              .update(tasks)
              .set(
                prune({
                  ...taskValues(userId, task, state, validGoals, validTasks),
                  deletedAt: null,
                  version: sql`${tasks.version} + 1`,
                  updatedAt: now,
                }),
              )
              .where(and(eq(tasks.userId, userId), eq(tasks.id, task.id)));
            counters.added += 1;
            continue;
          }
          await tx.insert(tasks).values(taskValues(userId, task, state, validGoals, validTasks));
          counters.added += 1;
        }

        /* ---- routines：陈旧软删进回收区；命中行重写步骤 ---- */
        const staleRoutines = [...state.activeRoutineIds].filter((id) => !fileRoutineIdSet.has(id));
        if (staleRoutines.length > 0) {
          await tx
            .update(routines)
            .set({ deletedAt: now, version: sql`${routines.version} + 1`, updatedAt: now })
            .where(and(eq(routines.userId, userId), inArray(routines.id, staleRoutines)));
          counters.cleared += staleRoutines.length;
        }
        for (const routine of uniqueById(file.routines).list as readonly (ExportEntity & {
          steps?: readonly ExportEntity[];
        })[]) {
          const fileSteps = uniqueById(routine.steps ?? []);
          if (state.allRoutineIds.has(routine.id)) {
            await tx
              .update(routines)
              .set(
                prune({
                  ...routineValues(userId, routine, state),
                  deletedAt: null,
                  version: sql`${routines.version} + 1`,
                  updatedAt: now,
                }),
              )
              .where(and(eq(routines.userId, userId), eq(routines.id, routine.id)));
            counters.skipped += state.activeRoutineIds.has(routine.id) ? 1 : 0;
            if (!state.activeRoutineIds.has(routine.id)) {
              counters.added += 1;
            }

            // 步骤重写：既有步骤（含软删态）与文件步骤按 id 对齐——
            // 陈旧活跃步骤软删（墓碑走同步）、文件侧命中则更新/复活、缺的插入。
            const existingSteps = await tx
              .select({ id: routineSteps.id, deletedAt: routineSteps.deletedAt })
              .from(routineSteps)
              .where(and(eq(routineSteps.userId, userId), eq(routineSteps.routineId, routine.id)));
            const existingActiveIds = new Set(
              existingSteps.filter((row) => row.deletedAt === null).map((row) => row.id),
            );
            const staleStepIds = [...existingActiveIds].filter((id) => !fileSteps.ids.has(id));
            if (staleStepIds.length > 0) {
              await tx
                .update(routineSteps)
                .set({ deletedAt: now, version: sql`${routineSteps.version} + 1`, updatedAt: now })
                .where(
                  and(eq(routineSteps.userId, userId), inArray(routineSteps.id, staleStepIds)),
                );
            }
            for (const step of fileSteps.list) {
              const exists = existingSteps.some((row) => row.id === step.id);
              if (exists) {
                await tx
                  .update(routineSteps)
                  .set(
                    prune({
                      ...stepValues(userId, routine.id, step),
                      deletedAt: null,
                      version: sql`${routineSteps.version} + 1`,
                      updatedAt: now,
                    }),
                  )
                  .where(and(eq(routineSteps.userId, userId), eq(routineSteps.id, step.id)));
                continue;
              }
              await tx.insert(routineSteps).values(stepValues(userId, routine.id, step));
            }
            continue;
          }
          await tx.insert(routines).values(routineValues(userId, routine, state));
          for (const step of routine.steps ?? []) {
            await tx.insert(routineSteps).values(stepValues(userId, routine.id, step));
          }
          counters.added += 1;
        }

        /* ---- execution_logs：追加式，命中即保留、陈旧原样（无删除语义） ---- */
        for (const log of uniqueById(file.executionLogs).list) {
          if (state.activeLogIds.has(log.id)) {
            counters.skipped += 1;
            continue;
          }
          await tx.insert(executionLogs).values(logValues(userId, log, state, validTasks));
          counters.added += 1;
        }

        /* ---- expenses：陈旧软删进回收区 ---- */
        const staleExpenses = [...state.activeExpenseIds].filter((id) => !fileExpenseIdSet.has(id));
        if (staleExpenses.length > 0) {
          await tx
            .update(expenses)
            .set({ deletedAt: now, version: sql`${expenses.version} + 1`, updatedAt: now })
            .where(and(eq(expenses.userId, userId), inArray(expenses.id, staleExpenses)));
          counters.cleared += staleExpenses.length;
        }
        for (const expense of uniqueById(file.expenses).list) {
          if (state.activeExpenseIds.has(expense.id)) {
            await tx
              .update(expenses)
              .set(
                prune({
                  ...expenseValues(userId, expense, state, validGoals),
                  deletedAt: null,
                  version: sql`${expenses.version} + 1`,
                  updatedAt: now,
                }),
              )
              .where(and(eq(expenses.userId, userId), eq(expenses.id, expense.id)));
            counters.skipped += 1;
            continue;
          }
          if (state.allExpenseIds.has(expense.id)) {
            await tx
              .update(expenses)
              .set(
                prune({
                  ...expenseValues(userId, expense, state, validGoals),
                  deletedAt: null,
                  version: sql`${expenses.version} + 1`,
                  updatedAt: now,
                }),
              )
              .where(and(eq(expenses.userId, userId), eq(expenses.id, expense.id)));
            counters.added += 1;
            continue;
          }
          await tx.insert(expenses).values(expenseValues(userId, expense, state, validGoals));
          counters.added += 1;
        }

        /* ---- reviews：覆盖写；调整随复盘对齐（非同步实体，陈旧物理删除） ---- */
        const fileReviewList = uniqueById(file.reviews).list as readonly (ExportEntity & {
          adjustments?: readonly ExportEntity[];
        })[];
        const fileReviewIdSet = new Set(fileReviewList.map((review) => review.id));
        const existingAdjustments =
          fileReviewList.length === 0
            ? []
            : await tx
                .select({ id: reviewAdjustments.id, reviewId: reviewAdjustments.reviewId })
                .from(reviewAdjustments)
                .where(
                  and(
                    eq(reviewAdjustments.userId, userId),
                    inArray(reviewAdjustments.reviewId, [...fileReviewIdSet]),
                  ),
                );
        const fileAdjustmentIds = new Set<string>();
        for (const review of fileReviewList) {
          for (const adjustment of review.adjustments ?? []) {
            fileAdjustmentIds.add(adjustment.id);
          }
        }
        const staleAdjustmentIds = existingAdjustments
          .filter((row) => !fileAdjustmentIds.has(row.id))
          .map((row) => row.id);
        if (staleAdjustmentIds.length > 0) {
          // 复盘调整不参与同步（DB §4.11.4 注：拍板 1 仅 expense/review 两实体），
          // 物理删除无墓碑缺口。
          await tx
            .delete(reviewAdjustments)
            .where(
              and(
                eq(reviewAdjustments.userId, userId),
                inArray(reviewAdjustments.id, staleAdjustmentIds),
              ),
            );
        }
        for (const review of fileReviewList) {
          if (state.activeReviewIds.has(review.id)) {
            await tx
              .update(reviews)
              .set(
                prune({
                  ...reviewValues(userId, review),
                  version: sql`${reviews.version} + 1`,
                  updatedAt: now,
                }),
              )
              .where(and(eq(reviews.userId, userId), eq(reviews.id, review.id)));
            counters.skipped += 1;
          } else {
            await tx.insert(reviews).values(reviewValues(userId, review));
            counters.added += 1;
          }
          for (const adjustment of review.adjustments ?? []) {
            const exists = existingAdjustments.some((row) => row.id === adjustment.id);
            if (exists) {
              continue;
            }
            await tx
              .insert(reviewAdjustments)
              .values(adjustmentValues(userId, review.id, adjustment));
          }
        }

        /* ---- settings：覆盖写（字段缺失保留现值） ---- */
        if (file.settings !== null) {
          await tx
            .update(users)
            .set(settingsUpdate(file.settings, now))
            .where(eq(users.id, userId));
          counters.skipped += 1;
        }

        return { added: counters.added, skipped: counters.skipped, cleared: counters.cleared };
      });
    },
  };
}

/** 陈旧行数＝活跃既有 − 文件（replace 会进回收区的那部分）。 */
function countStale(activeIds: ReadonlySet<string>, fileIds: ReadonlySet<string>): number {
  let count = 0;
  for (const id of activeIds) {
    if (!fileIds.has(id)) {
      count += 1;
    }
  }
  return count;
}
