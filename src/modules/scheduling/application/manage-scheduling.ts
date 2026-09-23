/**
 * 排程用例（SCHED-001/002，接口 §6）：时间块与固定事项的写路径 + 窗口读取。
 *
 * 冲突检测（§6 冻结）：半开区间、与未取消块 + 当日固定事项实例比、
 * 相邻不撞；有重叠 → `warning`，用户显式「仍要保留」经 PATCH 记 `confirmed`。
 * 固定事项窗口读取前先物化重复实例（§4.16，幂等靠唯一约束）。
 */
import { z } from 'zod';

import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { NotFoundError, ValidationError } from '@/shared/errors/app-error.ts';

import {
  assertFixedCommitmentInput,
  blockStatusAfterPatch,
  assertBlockWindow,
  type FixedCommitment,
  type ScheduleBlock,
  type ScheduleBlockCreateInput,
  type ScheduleBlockPatch,
} from '../domain/schedule-block.ts';
import {
  mergeConflicts,
  detectBlockConflicts,
  detectFixedConflicts,
  type ConflictItem,
} from '../domain/conflict.ts';
import { parseRecurrenceRule } from '../domain/recurrence.ts';
import { assertTimeZone, zonedToUtc, addDays, calendarDayOf } from '../domain/zoned-time.ts';
import { materializeWindow } from './materialize.ts';
import type { ScheduleBlockRepository } from '../domain/schedule-block-repository.ts';
import type {
  FixedCommitmentRepository,
  FixedCommitmentCreateInput,
} from '../domain/fixed-commitment-repository.ts';
import type { TaskRepository } from '../../tasks/domain/task-repository.ts';

/* ------------------------------------------------------------------ */
/* 请求校验                                                            */
/* ------------------------------------------------------------------ */

const uuidField = z.uuid();
const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: '时间必须是合法的 ISO 8601' });
const ianaTimeZone = z.string().min(1).max(64);

export const createScheduleBlockSchema = z
  .object({
    taskId: uuidField.nullish(),
    actionId: uuidField.nullish(),
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    timezone: ianaTimeZone,
    source: z.enum(['manual', 'suggested', 'imported']).default('manual'),
  })
  .strict();

export const updateScheduleBlockSchema = z
  .object({
    version: z.number().int().positive(),
    taskId: uuidField.nullish(),
    actionId: uuidField.nullish(),
    startsAt: isoDateTime.optional(),
    endsAt: isoDateTime.optional(),
    timezone: ianaTimeZone.optional(),
    /** 冲突确认：带 warning 的块被显式保留后记 confirmed（§6）。 */
    confirmConflicts: z.boolean().optional(),
  })
  .strict();

export const blockWindowQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: ianaTimeZone,
    includeCancelled: z.enum(['true']).optional(),
  })
  .strict();

export const createFixedCommitmentSchema = z
  .object({
    title: z
      .string()
      .trim()
      .refine((v) => v.length > 0, { message: '标题不能为空' })
      .refine((v) => v.length <= 240, { message: '标题不能超过 240 个字符' }),
    // 单次形态。
    startsAt: isoDateTime.nullish(),
    endsAt: isoDateTime.nullish(),
    // 重复形态。
    startsAtLocal: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullish(),
    durationMinutes: z.number().int().positive().nullish(),
    recurrenceRule: z.unknown().optional(),
    timezone: ianaTimeZone,
  })
  .strict();

export const updateFixedCommitmentSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(240).optional(),
    startsAt: isoDateTime.optional(),
    endsAt: isoDateTime.optional(),
    startsAtLocal: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    durationMinutes: z.number().int().positive().optional(),
    timezone: ianaTimeZone.optional(),
    recurrenceRule: z.unknown().optional(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* 冲突结果的对外形态                                                   */
/* ------------------------------------------------------------------ */

export interface BlockWithConflicts {
  readonly block: ScheduleBlock;
  readonly conflictState: ScheduleBlock['conflictState'];
  readonly conflicts: readonly ConflictItem[];
}

/* ------------------------------------------------------------------ */
/* 时间块用例                                                          */
/* ------------------------------------------------------------------ */

export interface ManageSchedulingDependencies {
  readonly blocks: ScheduleBlockRepository;
  readonly fixed: FixedCommitmentRepository;
  readonly tasks: TaskRepository;
  readonly audit: AuditLogger;
}

export class ManageScheduleBlockUseCase {
  readonly #deps: ManageSchedulingDependencies;

  constructor(dependencies: ManageSchedulingDependencies) {
    this.#deps = dependencies;
  }

  /** 窗口读取（先物化重复任务/固定事项，再查）。 */
  async listWindow(
    userId: string,
    query: z.infer<typeof blockWindowQuerySchema>,
  ): Promise<readonly ScheduleBlock[]> {
    if (query.to < query.from || query.to > addDays(query.from, 41)) {
      throw new ValidationError('查询窗口为空或超过 42 天上限');
    }
    assertTimeZone(query.timezone);
    const windowStart = zonedToUtc(query.from, '00:00', query.timezone);
    const windowEnd = zonedToUtc(addDays(query.to, 1), '00:00', query.timezone);

    await materializeWindow(userId, query.from, query.to, {
      tasks: this.#deps.tasks,
      fixed: this.#deps.fixed,
    });

    const blocks = await this.#deps.blocks.listOverlapping(userId, windowStart, windowEnd);
    return query.includeCancelled === 'true'
      ? blocks
      : blocks.filter((block) => block.status !== 'cancelled');
  }

  async create(
    userId: string,
    payload: z.infer<typeof createScheduleBlockSchema>,
    requestId?: string,
  ): Promise<BlockWithConflicts> {
    assertTimeZone(payload.timezone);
    const startsAtUtc = new Date(payload.startsAt);
    const endsAtUtc = new Date(payload.endsAt);
    assertBlockWindow(startsAtUtc, endsAtUtc);

    // 归属校验：taskId/actionId 给出时必须属于当前用户（不泄露存在性）。
    if (payload.taskId != null) {
      const task = await this.#deps.tasks.findById(userId, payload.taskId);
      if (task === null) {
        throw new NotFoundError('任务不存在');
      }
    }

    // 冲突检测范围＝候选窗当日（±1 日护栏）覆盖的日历日，物化固定事项后比对。
    const conflicts = await this.#detectConflicts(
      userId,
      startsAtUtc,
      endsAtUtc,
      payload.timezone,
      null,
    );

    const input: ScheduleBlockCreateInput = {
      taskId: payload.taskId ?? null,
      actionId: payload.actionId ?? null,
      startsAtUtc,
      endsAtUtc,
      timezone: payload.timezone,
      source: payload.source,
      routineId: null,
      routineStepId: null,
    };
    const block = await this.#deps.blocks.create(userId, input);
    this.#record('DATA_CREATED', userId, requestId);

    return {
      block,
      conflictState: conflicts.length > 0 ? 'warning' : 'none',
      conflicts,
    };
  }

  async update(
    userId: string,
    blockId: string,
    payload: z.infer<typeof updateScheduleBlockSchema>,
    requestId?: string,
  ): Promise<BlockWithConflicts> {
    const current = await this.#requireBlock(userId, blockId);

    const startsAtUtc =
      payload.startsAt === undefined ? current.startsAtUtc : new Date(payload.startsAt);
    const endsAtUtc = payload.endsAt === undefined ? current.endsAtUtc : new Date(payload.endsAt);
    const timezone = payload.timezone ?? current.timezone;
    if (payload.timezone !== undefined) {
      assertTimeZone(timezone);
    }
    assertBlockWindow(startsAtUtc, endsAtUtc);

    // 状态规则：completed/cancelled 不可移动；改动时间的 planned 转 adjusted。
    const status = blockStatusAfterPatch(current, {
      startsAtUtc: payload.startsAt === undefined ? undefined : startsAtUtc,
      endsAtUtc: payload.endsAt === undefined ? undefined : endsAtUtc,
      timezone: payload.timezone,
    });

    const conflicts = await this.#detectConflicts(
      userId,
      startsAtUtc,
      endsAtUtc,
      timezone,
      blockId,
    );

    const patch: ScheduleBlockPatch & { readonly status?: ScheduleBlock['status'] } = {
      ...(payload.taskId === undefined ? {} : { taskId: payload.taskId ?? null }),
      ...(payload.actionId === undefined ? {} : { actionId: payload.actionId ?? null }),
      startsAtUtc,
      endsAtUtc,
      timezone,
      // 时间没变（只改标题类字段）不触发 adjusted——blockStatusAfterPatch 已判。
      status,
    };
    // 「仍要保留」：显式确认冲突（§6）。确认只改 conflictState，不动时间。
    const conflictState: ScheduleBlock['conflictState'] =
      payload.confirmConflicts === true ? 'confirmed' : conflicts.length > 0 ? 'warning' : 'none';

    const block = await this.#deps.blocks.update(userId, blockId, payload.version, {
      ...patch,
      conflictState,
    });
    this.#record('DATA_UPDATED', userId, requestId);

    return { block, conflictState, conflicts };
  }

  /** 取消（终态）；重复取消/不存在按 404（接口 §6）。 */
  async cancel(userId: string, blockId: string, requestId?: string): Promise<void> {
    const current = await this.#requireBlock(userId, blockId);
    if (current.status === 'cancelled') {
      throw new NotFoundError('时间块不存在');
    }
    await this.#deps.blocks.update(userId, blockId, current.version, { status: 'cancelled' });
    this.#record('DATA_DELETED', userId, requestId);
  }

  async #requireBlock(userId: string, blockId: string): Promise<ScheduleBlock> {
    const block = await this.#deps.blocks.findById(userId, blockId);
    if (block === null) {
      throw new NotFoundError('时间块不存在');
    }
    return block;
  }

  async #detectConflicts(
    userId: string,
    startsAtUtc: Date,
    endsAtUtc: Date,
    timezone: string,
    excludeBlockId: string | null,
  ): Promise<readonly ConflictItem[]> {
    // 候选窗的本地日界——固定事项按日物化后比对。
    const fromDate = calendarDayOf(startsAtUtc, timezone);
    const toDate = calendarDayOf(endsAtUtc, timezone);
    await materializeWindow(userId, fromDate, toDate, {
      tasks: this.#deps.tasks,
      fixed: this.#deps.fixed,
    });

    const windowStart = new Date(startsAtUtc.getTime() - 1);
    const windowEnd = new Date(endsAtUtc.getTime() + 1);
    const blocks = await this.#deps.blocks.listOverlapping(userId, windowStart, windowEnd);
    const fixed = await this.#deps.fixed.listInstancesOverlapping(userId, windowStart, windowEnd);
    return mergeConflicts(
      detectBlockConflicts({ startsAtUtc, endsAtUtc }, blocks, excludeBlockId ?? undefined),
      detectFixedConflicts({ startsAtUtc, endsAtUtc }, fixed),
    );
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

/**
 * 固定事项用例（SCHED-002 / §4.16）：单次与重复模板两形态；写入不回传冲突
 * （§6——冲突在块创建与 /today 检出）；PATCH 实例行＝改当前一次、PATCH
 * 模板行＝改未来规则（历史实例不重写，UI 先问「当前一次 / 未来所有」）。
 */
export class ManageFixedCommitmentUseCase {
  readonly #deps: ManageSchedulingDependencies;

  constructor(dependencies: ManageSchedulingDependencies) {
    this.#deps = dependencies;
  }

  async listWindow(
    userId: string,
    query: z.infer<typeof blockWindowQuerySchema>,
  ): Promise<readonly FixedCommitment[]> {
    if (query.to < query.from || query.to > addDays(query.from, 41)) {
      throw new ValidationError('查询窗口为空或超过 42 天上限');
    }
    assertTimeZone(query.timezone);
    const windowStart = zonedToUtc(query.from, '00:00', query.timezone);
    const windowEnd = zonedToUtc(addDays(query.to, 1), '00:00', query.timezone);
    await materializeWindow(userId, query.from, query.to, {
      tasks: this.#deps.tasks,
      fixed: this.#deps.fixed,
    });
    return this.#deps.fixed.listInstancesOverlapping(userId, windowStart, windowEnd);
  }

  async create(
    userId: string,
    payload: z.infer<typeof createFixedCommitmentSchema>,
    requestId?: string,
  ): Promise<FixedCommitment> {
    assertTimeZone(payload.timezone);
    const rule =
      payload.recurrenceRule === undefined ? null : parseRecurrenceRule(payload.recurrenceRule);
    const startsAt =
      payload.startsAt === undefined || payload.startsAt === null
        ? null
        : new Date(payload.startsAt);
    const endsAt =
      payload.endsAt === undefined || payload.endsAt === null ? null : new Date(payload.endsAt);
    assertFixedCommitmentInput({
      startsAt,
      endsAt,
      startsAtLocal: payload.startsAtLocal ?? null,
      recurrenceRule: rule,
      ...(rule === null || payload.durationMinutes === undefined || payload.durationMinutes === null
        ? {}
        : { durationMinutes: payload.durationMinutes }),
    });

    const input: FixedCommitmentCreateInput = {
      title: payload.title,
      templateId: null,
      // 单次事项的归属日历日（§4.16 实例行 NOT NULL）。
      localDate:
        rule === null && startsAt !== null ? calendarDayOf(startsAt, payload.timezone) : null,
      startsAtUtc: rule === null ? startsAt : null,
      endsAtUtc: rule === null ? endsAt : null,
      startsAtLocal: rule === null ? null : (payload.startsAtLocal ?? null),
      durationMinutes: rule === null ? 0 : (payload.durationMinutes ?? 0),
      timezone: payload.timezone,
      recurrenceRule: rule === null ? null : rule,
    };
    // 单次事项没有 durationMinutes 字段（由 ends-starts 承载）——仓储列 NOT NULL，
    // 用分钟差补齐语义。
    const withDuration: FixedCommitmentCreateInput =
      rule === null && startsAt !== null && endsAt !== null
        ? {
            ...input,
            durationMinutes: Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000),
          }
        : input;

    const created = await this.#deps.fixed.create(userId, withDuration);
    this.#record('DATA_CREATED', userId, requestId);
    return created;
  }

  async update(
    userId: string,
    id: string,
    payload: z.infer<typeof updateFixedCommitmentSchema>,
    requestId?: string,
  ): Promise<FixedCommitment> {
    const current = await this.#requireCommitment(userId, id);

    // 时间统一先解析（readonly 补丁字段用条件展开组装，不就地改）。
    const nextStarts =
      payload.startsAt === undefined ? current.startsAtUtc : new Date(payload.startsAt);
    const nextEnds = payload.endsAt === undefined ? current.endsAtUtc : new Date(payload.endsAt);

    let patch: Parameters<FixedCommitmentRepository['update']>[3] = {
      ...(payload.title === undefined ? {} : { title: payload.title }),
      ...(payload.durationMinutes === undefined || payload.durationMinutes === null
        ? {}
        : { durationMinutes: payload.durationMinutes }),
      ...(payload.timezone === undefined ? {} : { timezone: payload.timezone }),
    };
    if (current.recurrenceRule === null) {
      // 单次实例：时间直改（校验 ends > starts）。
      if (nextStarts !== null && nextEnds !== null) {
        assertBlockWindow(nextStarts, nextEnds);
      }
      patch = {
        ...patch,
        ...(payload.startsAt === undefined || nextStarts === null
          ? {}
          : { startsAtUtc: nextStarts as Date }),
        ...(payload.endsAt === undefined || nextEnds === null
          ? {}
          : { endsAtUtc: nextEnds as Date }),
      };
    } else {
      // 模板行：改未来规则，历史实例不重写（§4.16）。
      patch = {
        ...patch,
        ...(payload.startsAtLocal === undefined ? {} : { startsAtLocal: payload.startsAtLocal }),
        ...(payload.recurrenceRule === undefined
          ? {}
          : { recurrenceRule: parseRecurrenceRule(payload.recurrenceRule) }),
      };
    }

    const updated = await this.#deps.fixed.update(userId, id, payload.version, patch);
    this.#record('DATA_UPDATED', userId, requestId);
    return updated;
  }

  async delete(userId: string, id: string, requestId?: string): Promise<void> {
    const deleted = await this.#deps.fixed.softDelete(userId, id);
    if (!deleted) {
      throw new NotFoundError('固定事项不存在');
    }
    this.#record('DATA_DELETED', userId, requestId);
  }

  async #requireCommitment(userId: string, id: string): Promise<FixedCommitment> {
    const commitment = await this.#deps.fixed.findById(userId, id);
    if (commitment === null || commitment.deletedAt !== null) {
      throw new NotFoundError('固定事项不存在');
    }
    return commitment;
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
