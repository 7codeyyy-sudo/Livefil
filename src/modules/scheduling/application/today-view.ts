/**
 * 今日一屏聚合（UI-007 / FR-030，接口 §6 `GET /today`）。
 *
 * 一次返回 blocks / fixedCommitments / unscheduledTasks / routines / habits /
 * load / recovery——前端不多次拼请求（UI v0.20 冻结）。窗口按用户时区切日；
 * 恢复建议规则在 execution 领域纯函数（规则落 domain 层、非前端文案）。
 */
import { z } from 'zod';

import type { TaskRepository } from '../../tasks/domain/task-repository.ts';
import type { ActionRepository, GoalRepository } from '../../goals/domain/goal-repository.ts';
import type { RoutineRepository } from '../../routines/domain/routine-repository.ts';
import { ruleMatchesDate } from '../domain/recurrence.ts';
import { calendarDayOf, addDays, zonedToUtc } from '../domain/zoned-time.ts';
import type { ScheduleBlockRepository } from '../domain/schedule-block-repository.ts';
import type { FixedCommitmentRepository } from '../domain/fixed-commitment-repository.ts';
import type {
  ExecutionLogRepository,
  RecoveryStateRepository,
} from '../../execution/domain/execution-repository.ts';
import {
  buildRecoverySuggestions,
  countsAsCompleted,
  detectAutoTrigger,
  type RecoverySuggestion,
} from '../../execution/domain/recovery.ts';
import { materializeWindow } from './materialize.ts';

export const todayQuerySchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    timezone: z.string().min(1).max(64),
  })
  .strict();

export interface BuildTodayViewDependencies {
  readonly blocks: ScheduleBlockRepository;
  readonly fixed: FixedCommitmentRepository;
  readonly tasks: TaskRepository;
  readonly goals: GoalRepository;
  readonly actions: ActionRepository;
  readonly routines: RoutineRepository;
  readonly logs: ExecutionLogRepository;
  readonly recovery: RecoveryStateRepository;
}

const CLEAR_MINUTES = 960;

export async function buildTodayView(
  userId: string,
  query: z.infer<typeof todayQuerySchema>,
  now: Date,
  deps: BuildTodayViewDependencies,
): Promise<Record<string, unknown>> {
  const timezone = query.timezone;
  const date = query.date ?? calendarDayOf(now, timezone);
  const windowStart = zonedToUtc(date, '00:00', timezone);
  const windowEnd = zonedToUtc(addDays(date, 1), '00:00', timezone);

  // 物化先于一切读取（冻结口径：展开在窗口内查询时发生）。
  await materializeWindow(userId, date, date, {
    tasks: deps.tasks,
    fixed: deps.fixed,
  });

  const allBlocks = await deps.blocks.listOverlapping(userId, windowStart, windowEnd);
  const blocks = allBlocks.filter((block) => block.status !== 'cancelled');
  const fixed = await deps.fixed.listInstancesOverlapping(userId, windowStart, windowEnd);

  const currentActionBlock = blocks.find(
    (block) =>
      block.startsAtUtc.getTime() <= now.getTime() && now.getTime() < block.endsAtUtc.getTime(),
  );

  const unscheduledTasks = await deps.tasks.listUnscheduledOn(userId, date, 50);

  // 例程：规则命中当日的（锚点＝创建日的本地日历日）；各步状态取当日块。
  const allRoutines = await deps.routines.listAll(userId);
  const routines = allRoutines
    .filter((detail) => {
      try {
        return ruleMatchesDate(
          detail.routine.recurrenceRule,
          calendarDayOf(new Date(detail.routine.createdAt), detail.routine.timezone),
          date,
        );
      } catch {
        return false;
      }
    })
    .map((detail) => ({
      id: detail.routine.id,
      name: detail.routine.name,
      scheduled: detail.steps.some((step) =>
        blocks.some((block) => block.routineStepId === step.id),
      ),
      steps: detail.steps.map((step) => {
        const block = blocks.find((candidate) => candidate.routineStepId === step.id);
        return {
          id: step.id,
          title: step.title,
          blockId: block?.id ?? null,
          status: block?.status ?? null,
        };
      }),
    }));

  // 习惯（无独立表）：active 目标下带 targetFrequency 的行动；doneToday 据当日 logs。
  const habits = await deps.actions.listHabitActions(userId);

  // 块标题（阻塞 3 修正）：任务块取任务标题、例程块取步骤标题、其余自由安排。
  const blockTaskIds = blocks.map((b) => b.taskId).filter((id): id is string => id !== null);
  const tasksById = new Map(
    (await deps.tasks.findByIds(userId, blockTaskIds)).map((task) => [task.id, task]),
  );
  const stepTitleById = new Map<string, string>();
  for (const detail of allRoutines) {
    for (const step of detail.steps) {
      stepTitleById.set(step.id, step.title);
    }
  }
  const dayLogs = await deps.logs.listInWindow(userId, windowStart, windowEnd);
  const habitItems = habits.map((action) => ({
    actionId: action.id,
    goalId: action.goalId,
    title: action.name,
    targetFrequency: action.targetFrequency,
    doneToday: dayLogs.some((log) => log.actionId === action.id && countsAsCompleted(log.status)),
  }));

  const minutesOf = (start: Date, end: Date): number =>
    Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
  const fixedMinutes = fixed.reduce(
    (total, item) =>
      total +
      (item.startsAtUtc !== null && item.endsAtUtc !== null
        ? minutesOf(item.startsAtUtc, item.endsAtUtc)
        : item.durationMinutes),
    0,
  );
  const plannedMinutes = blocks.reduce(
    (total, block) => total + minutesOf(block.startsAtUtc, block.endsAtUtc),
    0,
  );
  const completedMinutes = blocks
    .filter((block) => block.status === 'completed')
    .reduce((total, block) => total + minutesOf(block.startsAtUtc, block.endsAtUtc), 0);
  const availableMinutes = CLEAR_MINUTES - fixedMinutes;
  const overloaded = plannedMinutes > availableMinutes;

  // 恢复：手动状态落库；自动提示回看 7 个有计划日现算；建议只对手动恢复态展开。
  const manualState = await deps.recovery.get(userId);
  const manual = manualState?.enabled === true;

  // 完成率统计窗口：今天往前 13 个自然日（冻结口径取"最近 7 个有计划日"）。
  const statsFrom = addDays(date, -13);
  const statBlocks = await deps.blocks.listOverlapping(
    userId,
    zonedToUtc(statsFrom, '00:00', timezone),
    windowEnd,
  );
  const statLogs = await deps.logs.listOverlapping(
    userId,
    zonedToUtc(statsFrom, '00:00', timezone),
    windowEnd,
  );
  const statDays: { date: string; plannedMinutes: number; completedMinutes: number }[] = [];
  for (let offset = 0; offset <= 13; offset += 1) {
    const day = addDays(statsFrom, offset);
    const dayStart = zonedToUtc(day, '00:00', timezone);
    const dayEnd = zonedToUtc(addDays(day, 1), '00:00', timezone);
    const dayBlocks = statBlocks.filter(
      (block) =>
        block.status !== 'cancelled' && block.startsAtUtc >= dayStart && block.startsAtUtc < dayEnd,
    );
    const dayLogs = statLogs.filter((log) => log.occurredAt >= dayStart && log.occurredAt < dayEnd);
    statDays.push({
      date: day,
      plannedMinutes: dayBlocks.reduce(
        (total, block) => total + minutesOf(block.startsAtUtc, block.endsAtUtc),
        0,
      ),
      completedMinutes: dayLogs
        .filter((log) => countsAsCompleted(log.status))
        .reduce((total, log) => total + (log.actualMinutes ?? log.plannedMinutes ?? 0), 0),
    });
  }
  const autoTriggered = !manual && detectAutoTrigger(statDays);

  // 建议（手动恢复态）：对今日未完成块按冻结顺序生成；标题经批量任务读取。
  let suggestions: readonly RecoverySuggestion[] = [];
  if (manual) {
    const taskIds = blocks.map((block) => block.taskId).filter((id): id is string => id !== null);
    const tasksById = new Map(
      (await deps.tasks.findByIds(userId, taskIds)).map((task) => [task.id, task]),
    );
    const suggestionBlocks = blocks
      .filter((block) => block.status !== 'completed')
      .map((block) => ({
        id: block.id,
        title:
          block.taskId !== null ? (tasksById.get(block.taskId)?.title ?? '这个任务') : '这个安排',
        status: block.status,
        endsAtUtc: block.endsAtUtc,
        durationMinutes: minutesOf(block.startsAtUtc, block.endsAtUtc),
        taskId: block.taskId,
        minimumVersion:
          block.taskId !== null ? (tasksById.get(block.taskId)?.minimumVersion ?? null) : null,
      }));
    // 今日空档：now→日终 减去块与固定事项（只用于"还有没有空档"的判定）。
    const occupied = [...blocks, ...fixed]
      .filter((item) => item.endsAtUtc !== undefined && item.endsAtUtc !== null)
      .map((item) => ({
        start: item.startsAtUtc instanceof Date ? item.startsAtUtc : windowStart,
        end: item.endsAtUtc instanceof Date ? item.endsAtUtc : windowStart,
      }))
      .filter((slot) => slot.end > now)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    let cursor = now.getTime();
    const freeSlots: { start: Date; end: Date }[] = [];
    for (const slot of occupied) {
      if (slot.start.getTime() > cursor) {
        freeSlots.push({ start: new Date(cursor), end: slot.start });
      }
      cursor = Math.max(cursor, slot.end.getTime());
    }
    if (cursor < windowEnd.getTime()) {
      freeSlots.push({ start: new Date(cursor), end: windowEnd });
    }
    const usableSlots = freeSlots.filter(
      (slot) => slot.end.getTime() - slot.start.getTime() >= 15 * 60_000,
    );

    suggestions = buildRecoverySuggestions({
      blocks: suggestionBlocks,
      now,
      overloaded,
      freeSlots: usableSlots,
    });
  }

  return {
    date,
    currentAction:
      currentActionBlock === undefined
        ? null
        : {
            blockId: currentActionBlock.id,
            title: await titleOf(currentActionBlock, userId, deps),
            startsAtUtc: currentActionBlock.startsAtUtc.toISOString(),
            endsAtUtc: currentActionBlock.endsAtUtc.toISOString(),
          },
    blocks: blocks.map((block) => ({
      id: block.id,
      taskId: block.taskId,
      actionId: block.actionId,
      routineId: block.routineId,
      routineStepId: block.routineStepId,
      title:
        block.taskId !== null
          ? (tasksById.get(block.taskId)?.title ?? null)
          : block.routineStepId !== null
            ? (stepTitleById.get(block.routineStepId) ?? null)
            : null,
      startsAtUtc: block.startsAtUtc.toISOString(),
      endsAtUtc: block.endsAtUtc.toISOString(),
      status: block.status,
      source: block.source,
      conflictState: block.conflictState,
      version: block.version,
    })),
    fixedCommitments: fixed.map((item) => ({
      id: item.id,
      title: item.title,
      startsAtUtc: item.startsAtUtc?.toISOString() ?? null,
      endsAtUtc: item.endsAtUtc?.toISOString() ?? null,
    })),
    unscheduledTasks: unscheduledTasks.map((task) => ({
      id: task.id,
      title: task.title,
      dueDate: task.dueDate,
      overdue: task.dueDate !== null && task.dueDate < date,
    })),
    routines,
    habits: habitItems,
    load: { fixedMinutes, plannedMinutes, completedMinutes, availableMinutes, overloaded },
    recovery: {
      manual,
      since: manualState?.enabled === true ? manualState.since : null,
      autoTriggered,
      suggestions,
    },
  };
}

async function titleOf(
  block: { readonly taskId: string | null },
  userId: string,
  deps: BuildTodayViewDependencies,
): Promise<string | null> {
  if (block.taskId !== null) {
    const task = await deps.tasks.findById(userId, block.taskId);
    return task?.title ?? null;
  }
  return null;
}
