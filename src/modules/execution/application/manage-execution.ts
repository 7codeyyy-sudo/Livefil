/**
 * 执行记录与恢复模式用例（EXEC-001/002，接口 §7）。
 *
 * 写路径：校验归属 → 领域校验 → 追加记录 → **联动**块/任务状态
 * （联动规则＝domain 纯函数；重复记录靠 Idempotency-Key 在路由层挡）。
 * 恢复模式：手动态单行 upsert；建议生成在 domain 纯函数（/today 消费）。
 */
import { z } from 'zod';

import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { NotFoundError } from '@/shared/errors/app-error.ts';

import {
  assertExecutionLogInput,
  blockStatusForLog,
  taskStatusForLog,
  type ExecutionLog,
  type ExecutionLogCreateInput,
} from '../domain/execution-log.ts';
import type {
  ExecutionLogRepository,
  ListExecutionLogsOptions,
  RecoveryStateRepository,
} from '../domain/execution-repository.ts';
import { zonedToUtc } from '../../scheduling/domain/zoned-time.ts';
import type { ScheduleBlockRepository } from '../../scheduling/domain/schedule-block-repository.ts';
import type { TaskRepository } from '../../tasks/domain/task-repository.ts';

/** 日历日窗口 → UTC 瞬时（按用户时区切日界，次要 11 修正；转换复用 scheduling 领域）。 */
export function resolveUtcWindow(
  from: string,
  to: string,
  timezone: string,
): { readonly fromUtc: Date; readonly toUtc: Date } {
  const windowStart = zonedToUtc(from, '00:00', timezone);
  const windowEnd = zonedToUtc(nextDay(to), '00:00', timezone);
  return { fromUtc: windowStart, toUtc: windowEnd };
}

function nextDay(date: string): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
}

export const createExecutionLogSchema = z
  .object({
    taskId: z.uuid().nullish(),
    actionId: z.uuid().nullish(),
    scheduleBlockId: z.uuid().nullish(),
    status: z.enum(['completed', 'minimum_completed', 'partial', 'deferred', 'skipped']),
    plannedMinutes: z.number().int().min(0).nullish(),
    actualMinutes: z.number().int().min(0).nullish(),
    reasonCode: z.enum(['NO_ENERGY', 'NO_TIME', 'CONFLICT', 'TOO_HARD', 'NOT_IN_MOOD']).nullish(),
    energyLevel: z.enum(['low', 'medium', 'high']).nullish(),
    moodScore: z.number().int().min(1).max(5).nullish(),
    note: z.string().max(500).nullish(),
    occurredAt: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), { message: '时间必须是合法的 ISO 8601' })
      .nullish(),
  })
  .strict();

export const listExecutionLogsQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().min(1).max(64),
    taskId: z.uuid().optional(),
    actionId: z.uuid().optional(),
    status: z.enum(['completed', 'minimum_completed', 'partial', 'deferred', 'skipped']).optional(),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const setRecoveryModeSchema = z.object({ enabled: z.boolean() }).strict();

export interface RecordExecutionDependencies {
  readonly logs: ExecutionLogRepository;
  readonly blocks: ScheduleBlockRepository;
  readonly tasks: TaskRepository;
  readonly audit: AuditLogger;
}

export class RecordExecutionUseCase {
  readonly #deps: RecordExecutionDependencies;

  constructor(dependencies: RecordExecutionDependencies) {
    this.#deps = dependencies;
  }

  async create(
    userId: string,
    payload: z.infer<typeof createExecutionLogSchema>,
    requestId?: string,
  ): Promise<ExecutionLog> {
    // 归属校验：给到的 task / block 都必须属于当前用户（不泄露存在性）。
    if (payload.taskId != null) {
      const task = await this.#deps.tasks.findById(userId, payload.taskId);
      if (task === null) {
        throw new NotFoundError('任务不存在');
      }
    }
    let block = null;
    if (payload.scheduleBlockId != null) {
      block = await this.#deps.blocks.findById(userId, payload.scheduleBlockId);
      if (block === null) {
        throw new NotFoundError('时间块不存在');
      }
    }

    const input: ExecutionLogCreateInput = {
      taskId: payload.taskId ?? null,
      actionId: payload.actionId ?? null,
      scheduleBlockId: payload.scheduleBlockId ?? null,
      status: payload.status,
      plannedMinutes: payload.plannedMinutes ?? null,
      actualMinutes: payload.actualMinutes ?? null,
      reasonCode: payload.reasonCode ?? null,
      note: payload.note ?? null,
      energyLevel: payload.energyLevel ?? null,
      moodScore: payload.moodScore ?? null,
      occurredAt:
        payload.occurredAt === undefined || payload.occurredAt === null
          ? new Date()
          : new Date(payload.occurredAt),
    };
    assertExecutionLogInput(input);

    const log = await this.#deps.logs.create(userId, input);

    // 联动（接口 §7 冻结口径）：块完成/作废、任务进对应状态。
    const blockStatus = blockStatusForLog(payload.status);
    if (block !== null && blockStatus !== null && block.status !== 'completed') {
      await this.#deps.blocks.update(userId, block.id, block.version, { status: blockStatus });
    }
    if (input.taskId !== null) {
      const nextTaskStatus = taskStatusForLog(payload.status);
      const task = await this.#deps.tasks.findById(userId, input.taskId);
      // 任务已在目标态（重复记录）时静默跳过——追加式记录不重复推进状态。
      if (task !== null && task.status !== nextTaskStatus && task.deletedAt === null) {
        try {
          await this.#deps.tasks.updateStatus(userId, input.taskId, nextTaskStatus, {
            actualMinutes: input.actualMinutes,
            actualAmount: null,
            dueDate: undefined,
            lifeAreaId: undefined,
          });
        } catch {
          // 任务状态机的流转矩阵不放行（例如 completed → skipped）时保持任务
          // 现状：执行记录已经追加，历史事实不因联动失败而丢失。
        }
      }
    }

    this.#deps.audit.record({
      type: 'DATA_CREATED',
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
      ...(requestId === undefined ? {} : { requestId }),
    });
    return log;
  }

  async list(
    userId: string,
    options: ListExecutionLogsOptions,
  ): Promise<ReturnType<ExecutionLogRepository['list']>> {
    return this.#deps.logs.list(userId, options);
  }
}

export class ManageRecoveryModeUseCase {
  readonly #recovery: RecoveryStateRepository;
  readonly #audit: AuditLogger;

  constructor(deps: { recovery: RecoveryStateRepository; audit: AuditLogger }) {
    this.#recovery = deps.recovery;
    this.#audit = deps.audit;
  }

  async get(userId: string): Promise<{ manual: boolean; since: string | null }> {
    const state = await this.#recovery.get(userId);
    return {
      manual: state?.enabled === true,
      since: state?.enabled === true ? state.since : null,
    };
  }

  async set(
    userId: string,
    enabled: boolean,
    requestId?: string,
  ): Promise<{ manual: boolean; since: string }> {
    const state = await this.#recovery.set(userId, enabled);
    this.#audit.record({
      type: 'DATA_UPDATED',
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
      ...(requestId === undefined ? {} : { requestId }),
    });
    return { manual: state.enabled, since: state.since };
  }
}
