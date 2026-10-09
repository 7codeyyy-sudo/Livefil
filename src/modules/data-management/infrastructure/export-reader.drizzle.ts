/**
 * 导出读侧（OPS-002，《接口文档》§13 `POST /data-exports` 的内容面）。
 *
 * 范围＝FR-090 字面七类（契约「导出内容范围」）：任务、目标、执行记录、
 * 习惯（例程，**含嵌套步骤**）、开销、复盘（**含嵌套调整**）、设置。
 * 全部查询带 `user_id` 作用域（IAM-004 静态判定），只取**未软删**行——
 * 回收区里的行不属于「可导出的现状」。
 *
 * 列白名单显式映射（不是 `select *`）：`user_id`/`version`/`deleted_at`
 * 不进文件——前者由顶层 `userId` 承载，后两者是持久化细节（写入侧恒
 * 重建：version 从 1 起、deleted_at 恒空）。
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import {
  executionLogs,
  goals,
  reviews,
  reviewAdjustments,
  routineSteps,
  routines,
  tasks,
  users,
  expenses,
} from '@/infrastructure/database/schema.ts';

import type {
  ExportEntity,
  ExportFile,
  ExportRoutine,
  ExportReview,
  ExportSettings,
} from '../domain/export-format.ts';
import { CURRENT_FORMAT_VERSION } from '../domain/export-format.ts';
import type { ExportReader } from '../domain/data-ports.ts';

export function createExportReader(db: Database): ExportReader {
  return {
    async dump(userId: string, now: Date): Promise<ExportFile> {
      const [taskRows, goalRows, logRows, routineRows, expenseRows, reviewRows, userRows] =
        await Promise.all([
          db
            .select({
              id: tasks.id,
              lifeAreaId: tasks.lifeAreaId,
              goalId: tasks.goalId,
              actionId: tasks.actionId,
              title: tasks.title,
              status: tasks.status,
              estimatedMinutes: tasks.estimatedMinutes,
              minimumVersion: tasks.minimumVersion,
              dueDate: tasks.dueDate,
              recurrenceRule: tasks.recurrenceRule,
              templateId: tasks.templateId,
              source: tasks.source,
              createdAt: tasks.createdAt,
              updatedAt: tasks.updatedAt,
            })
            .from(tasks)
            .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt))),
          db
            .select({
              id: goals.id,
              lifeAreaId: goals.lifeAreaId,
              name: goals.name,
              reason: goals.reason,
              status: goals.status,
              startDate: goals.startDate,
              targetDate: goals.targetDate,
              resultMetric: goals.resultMetric,
              createdAt: goals.createdAt,
              updatedAt: goals.updatedAt,
            })
            .from(goals)
            .where(eq(goals.userId, userId)),
          db
            .select({
              id: executionLogs.id,
              taskId: executionLogs.taskId,
              actionId: executionLogs.actionId,
              scheduleBlockId: executionLogs.scheduleBlockId,
              status: executionLogs.status,
              plannedMinutes: executionLogs.plannedMinutes,
              actualMinutes: executionLogs.actualMinutes,
              reasonCode: executionLogs.reasonCode,
              note: executionLogs.note,
              energyLevel: executionLogs.energyLevel,
              moodScore: executionLogs.moodScore,
              occurredAt: executionLogs.occurredAt,
              createdAt: executionLogs.createdAt,
            })
            .from(executionLogs)
            .where(eq(executionLogs.userId, userId)),
          db
            .select({
              id: routines.id,
              lifeAreaId: routines.lifeAreaId,
              name: routines.name,
              recurrenceRule: routines.recurrenceRule,
              anchorTime: routines.anchorTime,
              timezone: routines.timezone,
              createdAt: routines.createdAt,
              updatedAt: routines.updatedAt,
            })
            .from(routines)
            .where(and(eq(routines.userId, userId), isNull(routines.deletedAt))),
          db
            .select({
              id: expenses.id,
              categoryId: expenses.categoryId,
              lifeAreaId: expenses.lifeAreaId,
              goalId: expenses.goalId,
              actionId: expenses.actionId,
              amountMinor: expenses.amountMinor,
              currencyCode: expenses.currencyCode,
              occurredOn: expenses.occurredOn,
              paymentMethod: expenses.paymentMethod,
              note: expenses.note,
              source: expenses.source,
              createdAt: expenses.createdAt,
              updatedAt: expenses.updatedAt,
            })
            .from(expenses)
            .where(and(eq(expenses.userId, userId), isNull(expenses.deletedAt))),
          db
            .select({
              id: reviews.id,
              reviewType: reviews.reviewType,
              periodKey: reviews.periodKey,
              answers: reviews.answers,
              energyLevel: reviews.energyLevel,
              snapshot: reviews.snapshot,
              snapshotSchemaVersion: reviews.snapshotSchemaVersion,
              createdAt: reviews.createdAt,
              updatedAt: reviews.updatedAt,
            })
            .from(reviews)
            .where(eq(reviews.userId, userId)),
          db
            .select({
              displayName: users.displayName,
              locale: users.locale,
              timezone: users.timezone,
              currencyCode: users.currencyCode,
              weekStartsOn: users.weekStartsOn,
              defaultTaskDurationMinutes: users.defaultTaskDurationMinutes,
              defaultBufferMinutes: users.defaultBufferMinutes,
              aiEnabled: users.aiEnabled,
              aiDataConsent: users.aiDataConsent,
              reminderEnabled: users.reminderEnabled,
              quietHoursStart: users.quietHoursStart,
              quietHoursEnd: users.quietHoursEnd,
            })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1),
        ]);

      const routineIds = routineRows.map((row) => row.id);
      const reviewIds = reviewRows.map((row) => row.id);
      const [stepRows, adjustmentRows] = await Promise.all([
        routineIds.length === 0
          ? Promise.resolve([])
          : db
              .select({
                id: routineSteps.id,
                routineId: routineSteps.routineId,
                title: routineSteps.title,
                position: routineSteps.position,
                estimatedMinutes: routineSteps.estimatedMinutes,
                minimumVersion: routineSteps.minimumVersion,
                createdAt: routineSteps.createdAt,
                updatedAt: routineSteps.updatedAt,
              })
              .from(routineSteps)
              .where(
                and(
                  eq(routineSteps.userId, userId),
                  inArray(routineSteps.routineId, routineIds),
                  isNull(routineSteps.deletedAt),
                ),
              ),
        reviewIds.length === 0
          ? Promise.resolve([])
          : db
              .select({
                id: reviewAdjustments.id,
                reviewId: reviewAdjustments.reviewId,
                targetType: reviewAdjustments.targetType,
                targetId: reviewAdjustments.targetId,
                action: reviewAdjustments.action,
                payload: reviewAdjustments.payload,
                createdAt: reviewAdjustments.createdAt,
              })
              .from(reviewAdjustments)
              .where(
                and(
                  eq(reviewAdjustments.userId, userId),
                  inArray(reviewAdjustments.reviewId, reviewIds),
                ),
              ),
      ]);

      const stepsByRoutine = new Map<string, readonly ExportEntity[]>();
      for (const step of stepRows) {
        const entity: ExportEntity = {
          id: step.id,
          title: step.title,
          position: step.position,
          estimatedMinutes: step.estimatedMinutes,
          minimumVersion: step.minimumVersion,
          createdAt: step.createdAt,
          updatedAt: step.updatedAt,
        };
        const list = stepsByRoutine.get(step.routineId) ?? [];
        stepsByRoutine.set(step.routineId, [...list, entity]);
      }
      const adjustmentsByReview = new Map<string, readonly ExportEntity[]>();
      for (const adjustment of adjustmentRows) {
        const entity: ExportEntity = {
          id: adjustment.id,
          targetType: adjustment.targetType,
          targetId: adjustment.targetId,
          action: adjustment.action,
          payload: adjustment.payload,
          createdAt: adjustment.createdAt,
        };
        const list = adjustmentsByReview.get(adjustment.reviewId) ?? [];
        adjustmentsByReview.set(adjustment.reviewId, [...list, entity]);
      }

      const exportedRoutines: readonly ExportRoutine[] = routineRows.map((row) => ({
        ...row,
        steps: stepsByRoutine.get(row.id) ?? [],
      }));
      const exportedReviews: readonly ExportReview[] = reviewRows.map((row) => ({
        ...row,
        adjustments: adjustmentsByReview.get(row.id) ?? [],
      }));

      const userRow = userRows[0];
      if (userRow === undefined) {
        // resolveSession 保证用户存在；真缺了说明库状态异常——让导出落 failed
        // 并记审计（用例层的兜底路径），不静默造一份空设置。
        throw new Error('导出失败：当前用户行不存在');
      }
      const settings: ExportSettings = {
        displayName: userRow.displayName,
        locale: userRow.locale,
        timezone: userRow.timezone,
        currencyCode: userRow.currencyCode,
        weekStartsOn: userRow.weekStartsOn,
        defaultTaskDurationMinutes: userRow.defaultTaskDurationMinutes,
        defaultBufferMinutes: userRow.defaultBufferMinutes,
        aiEnabled: userRow.aiEnabled,
        aiDataConsent: userRow.aiDataConsent,
        reminderEnabled: userRow.reminderEnabled,
        quietHoursStart: userRow.quietHoursStart,
        quietHoursEnd: userRow.quietHoursEnd,
      };

      return {
        formatVersion: CURRENT_FORMAT_VERSION,
        exportedAt: now.toISOString(),
        userId,
        tasks: taskRows as unknown as readonly ExportEntity[],
        goals: goalRows as unknown as readonly ExportEntity[],
        executionLogs: logRows as unknown as readonly ExportEntity[],
        routines: exportedRoutines,
        expenses: expenseRows.map((row) => ({
          ...row,
          // 金额按仓库铁律以字符串出域（bigint 直接 JSON.stringify 会抛）。
          amountMinor: String(row.amountMinor),
        })) as unknown as readonly ExportEntity[],
        reviews: exportedReviews,
        settings,
      };
    },
  };
}
