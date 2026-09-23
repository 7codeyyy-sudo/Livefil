/**
 * 例程用例（ROUTINE-001，接口 §8）：CRUD + 「安排到某日」物化展开。
 *
 * 安排展开（§4.7 冻结）：按 position 顺序、以起点评进，每步一个块
 * （source='routine'，回填 routine_id/routine_step_id）；无预估时长的步骤按
 * {@link DEFAULT_STEP_MINUTES} 展开（`ends > starts` 约束不允许零长块）。
 * 同日重复调用幂等：当日已有该例程的块时 409（不重复生成）。
 */
import { z } from 'zod';

import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { ConflictError, NotFoundError } from '@/shared/errors/app-error.ts';

import { assertRoutineInput, DEFAULT_STEP_MINUTES, type RoutineDetail } from '../domain/routine.ts';
import type { RoutineRepository } from '../domain/routine-repository.ts';
import type { ScheduleBlockRepository } from '../../scheduling/domain/schedule-block-repository.ts';
import type { FixedCommitmentRepository } from '../../scheduling/domain/fixed-commitment-repository.ts';
import {
  detectBlockConflicts,
  detectFixedConflicts,
  mergeConflicts,
  type ConflictItem,
} from '../../scheduling/domain/conflict.ts';
import type { LifeAreaRepository } from '../../life-areas/domain/life-area-repository.ts';
import type { ScheduleBlock } from '../../scheduling/domain/schedule-block.ts';

/** 展开结果：块 + 各自的冲突检测（§8 冻结：响应带 conflicts）。 */
export type BlockWithConflicts = Omit<ScheduleBlock, 'startsAtUtc' | 'endsAtUtc'> & {
  readonly startsAtUtc: string;
  readonly endsAtUtc: string;
  readonly conflicts: readonly ConflictItem[];
};
import { calendarDayOf, zonedToUtc } from '../../scheduling/domain/zoned-time.ts';

export const createRoutineSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    lifeAreaId: z.uuid().nullish(),
    recurrenceRule: z.unknown(),
    anchorTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullish(),
    timezone: z.string().min(1).max(64),
    steps: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(240),
          estimatedMinutes: z.number().int().positive().nullish(),
          minimumVersion: z.string().max(160).nullish(),
        }),
      )
      .min(1)
      .max(20),
  })
  .strict();

export const updateRoutineSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(160).optional(),
    lifeAreaId: z.uuid().nullish(),
    recurrenceRule: z.unknown().optional(),
    anchorTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullish(),
    timezone: z.string().min(1).max(64).optional(),
    steps: z
      .array(
        z
          .object({
            id: z.uuid().optional(),
            title: z.string().trim().min(1).max(240).optional(),
            estimatedMinutes: z.number().int().positive().nullish(),
            minimumVersion: z.string().max(160).nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .optional(),
  })
  .strict();

export const scheduleRoutineSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startAt: z.string().regex(/^\d{2}:\d{2}$/),
    timezone: z.string().min(1).max(64),
  })
  .strict();

export interface ManageRoutineDependencies {
  readonly routines: RoutineRepository;
  readonly blocks: ScheduleBlockRepository;
  readonly fixedCommitments: FixedCommitmentRepository;
  readonly lifeAreas: LifeAreaRepository;
  readonly audit: AuditLogger;
}

export class ManageRoutineUseCase {
  readonly #deps: ManageRoutineDependencies;

  constructor(dependencies: ManageRoutineDependencies) {
    this.#deps = dependencies;
  }

  async listAll(userId: string): Promise<readonly RoutineDetail[]> {
    return this.#deps.routines.listAll(userId);
  }

  async findDetail(userId: string, routineId: string): Promise<RoutineDetail> {
    const detail = await this.#requireDetail(userId, routineId);
    return detail;
  }

  async create(
    userId: string,
    payload: z.infer<typeof createRoutineSchema>,
    requestId?: string,
  ): Promise<RoutineDetail> {
    if (payload.lifeAreaId != null) {
      // 生活领域的归属由仓储端口校验是 tasks/goals 的先例；这里只挡不存在。
      await this.#requireLifeArea(userId, payload.lifeAreaId);
    }
    assertRoutineInput({
      recurrenceRule: payload.recurrenceRule,
      steps: payload.steps.map((step) => ({
        title: step.title,
        estimatedMinutes: step.estimatedMinutes ?? null,
        minimumVersion: step.minimumVersion ?? null,
      })),
    });
    const detail = await this.#deps.routines.create(userId, {
      name: payload.name,
      lifeAreaId: payload.lifeAreaId ?? null,
      recurrenceRule: payload.recurrenceRule,
      anchorTime: payload.anchorTime ?? null,
      timezone: payload.timezone,
      steps: payload.steps.map((step) => ({
        title: step.title,
        estimatedMinutes: step.estimatedMinutes ?? null,
        minimumVersion: step.minimumVersion ?? null,
      })),
    });
    this.#record('DATA_CREATED', userId, requestId);
    return detail;
  }

  async update(
    userId: string,
    routineId: string,
    payload: z.infer<typeof updateRoutineSchema>,
    requestId?: string,
  ): Promise<RoutineDetail> {
    if (payload.recurrenceRule !== undefined) {
      assertRoutineInput({
        recurrenceRule: payload.recurrenceRule,
        // 只改规则不改步骤时用占位单步（步骤 diff 的合法性由仓储层保证）。
        steps: [{ title: 'x', estimatedMinutes: null, minimumVersion: null }],
      });
    }
    const detail = await this.#deps.routines.update(
      userId,
      routineId,
      payload.version,
      {
        ...(payload.name === undefined ? {} : { name: payload.name }),
        ...(payload.lifeAreaId === undefined ? {} : { lifeAreaId: payload.lifeAreaId ?? null }),
        ...(payload.recurrenceRule === undefined ? {} : { recurrenceRule: payload.recurrenceRule }),
        ...(payload.anchorTime === undefined ? {} : { anchorTime: payload.anchorTime ?? null }),
        ...(payload.timezone === undefined ? {} : { timezone: payload.timezone }),
      },
      (payload.steps ?? []).map((step) => ({
        ...(step.id === undefined ? {} : { id: step.id }),
        ...(step.title === undefined ? {} : { title: step.title }),
        ...(step.estimatedMinutes === undefined
          ? {}
          : { estimatedMinutes: step.estimatedMinutes ?? null }),
        ...(step.minimumVersion === undefined
          ? {}
          : { minimumVersion: step.minimumVersion ?? null }),
      })),
    );
    this.#record('DATA_UPDATED', userId, requestId);
    return detail;
  }

  async delete(userId: string, routineId: string, requestId?: string): Promise<void> {
    const deleted = await this.#deps.routines.softDelete(userId, routineId);
    if (!deleted) {
      throw new NotFoundError('例程不存在');
    }
    this.#record('DATA_DELETED', userId, requestId);
  }

  /** 「安排到某日」（接口 §8）：同日已有该例程的块 → 409，不重复生成。 */
  async scheduleOnDate(
    userId: string,
    routineId: string,
    payload: z.infer<typeof scheduleRoutineSchema>,
    requestId?: string,
  ): Promise<readonly BlockWithConflicts[]> {
    const detail = await this.#requireDetail(userId, routineId);
    const startInstant = zonedToUtc(payload.date, payload.startAt, payload.timezone);
    const dayEnd = zonedToUtc(
      nextDay(calendarDayOf(startInstant, payload.timezone)),
      '00:00',
      payload.timezone,
    );

    const dayBlocks = await this.#deps.blocks.listOverlapping(userId, startInstant, dayEnd);
    if (dayBlocks.some((block) => block.routineId === routineId && block.status !== 'cancelled')) {
      throw new ConflictError('该例程当天已安排，不能重复生成');
    }

    let cursor = startInstant.getTime();
    const inputs = detail.steps.map((step) => {
      const duration = (step.estimatedMinutes ?? DEFAULT_STEP_MINUTES) * 60_000;
      const blockInput = {
        taskId: null,
        actionId: null,
        startsAtUtc: new Date(cursor),
        endsAtUtc: new Date(cursor + duration),
        timezone: payload.timezone,
        source: 'routine' as const,
        routineId,
        routineStepId: step.id,
      };
      cursor += duration;
      return blockInput;
    });

    const created = await this.#deps.blocks.bulkCreate(userId, inputs);
    // §8 冻结：各块带正常冲突检测结果（与既有块 + 当日固定事项比，
    // 同批步骤块彼此相邻不冲突——排除本批）。
    const createdIds = new Set(created.map((block) => block.id));
    const withConflicts = await Promise.all(
      created.map(async (block) => {
        const windowStart = new Date(block.startsAtUtc.getTime() - 1);
        const windowEnd = new Date(block.endsAtUtc.getTime() + 1);
        const existing = await this.#deps.blocks.listOverlapping(userId, windowStart, windowEnd);
        const others = existing.filter((item) => !createdIds.has(item.id));
        const fixed = await this.#deps.fixedCommitments.listInstancesOverlapping(
          userId,
          windowStart,
          windowEnd,
        );
        const conflicts = mergeConflicts(
          detectBlockConflicts(block, others),
          detectFixedConflicts(block, fixed),
        );
        return {
          ...block,
          startsAtUtc: block.startsAtUtc.toISOString(),
          endsAtUtc: block.endsAtUtc.toISOString(),
          conflicts: conflicts satisfies readonly ConflictItem[],
        };
      }),
    );
    this.#record('DATA_CREATED', userId, requestId);
    return withConflicts;
  }

  async #requireDetail(userId: string, routineId: string): Promise<RoutineDetail> {
    const detail = await this.#deps.routines.findDetail(userId, routineId);
    if (detail === null) {
      throw new NotFoundError('例程不存在');
    }
    return detail;
  }

  async #requireLifeArea(userId: string, lifeAreaId: string): Promise<void> {
    // 已归档领域不出现在选择器，也不接受被引用——对调用方与"不存在"同义。
    const area = await this.#deps.lifeAreas.findById(userId, lifeAreaId);
    if (area === null || area.isArchived) {
      throw new NotFoundError('生活领域不存在');
    }
  }

  #record(type: Parameters<AuditLogger['record']>[0]['type'], userId: string, requestId?: string) {
    this.#deps.audit.record({
      type,
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
}

function nextDay(date: string): string {
  const base = new Date(`${date}T00:00:00Z`);
  return new Date(base.getTime() + 86_400_000).toISOString().slice(0, 10);
}
