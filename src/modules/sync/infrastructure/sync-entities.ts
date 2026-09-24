/**
 * 同步实体注册表（SYNC-001 / SYNC-003 共用的表描述）。
 *
 * ## 为什么需要一张注册表
 *
 * 拉取要在 9 张表上做同一件事："按 `(change_at, id)` 取游标之后的变更"，写入要在
 * 同一批表上做 CAS 与软删。把每张表的差异（变更时刻列、墓碑判据、可写列、删除方式）
 * 收敛成数据，两个方向的实现就都只剩一份逻辑——否则每新增一个实体类型都要在四处
 * 复制粘贴，而复制品之间迟早会漂移（例如 pull 认为 `schedule_blocks` 的取消是墓碑、
 * push 却把它当成普通状态更新）。
 *
 * ## 墓碑的四类（《数据库设计文档》§4.18.1，PD-20260923-004 裁定 2）
 *
 * 1. `deleted_at` 软删：`actions` / `tasks` / `routines` / `routine_steps` / `fixed_commitments`；
 * 2. 状态即墓碑：`schedule_blocks` 的 `status='cancelled'`；
 * 3. 追加式无墓碑：`execution_logs`（只读，`deleted` 恒为 false）；
 * 4. 无删除语义：`life_areas` / `goals`（`deleted` 恒为 false，push 的 delete 判成拒绝）。
 */
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import {
  actions,
  executionLogs,
  fixedCommitments,
  goals,
  lifeAreas,
  routineSteps,
  routines,
  scheduleBlocks,
  tasks,
} from '@/infrastructure/database/schema.ts';

import type { SyncEntityType } from '../domain/sync-change.ts';

/** 行的通用形态：`payload` 与墓碑判据都只按键取值，不关心具体表。 */
export type PlainRow = Readonly<Record<string, unknown>>;

/** 删除方式。`unsupported` 的表也不接受 push 的 delete。 */
export type SyncDeletion = 'soft-delete' | 'cancel' | 'unsupported';

export interface SyncEntitySpec {
  readonly entityType: SyncEntityType;
  readonly table: PgTable;
  readonly idColumn: PgColumn;
  /** 归属列。每一条查询都必须带上它（IAM-004 的用户作用域断言）。 */
  readonly userIdColumn: PgColumn;
  /** 变更时刻表达式：`coalesce(updated_at, created_at)`，追加式表即 `created_at`。 */
  readonly changeAt: SQL;
  /** 变更时刻取自行里的哪个字段（游标要回填真实时刻）。 */
  readonly changeAtKey: 'updatedAt' | 'createdAt';
  /** 版本列；追加式表为 `null`（版本恒为 1）。 */
  readonly versionColumn: PgColumn | null;
  /** 墓碑判据。 */
  readonly deletedOf: (row: PlainRow) => boolean;
  /** push 可写列：payload 键 → 列。空对象表示该实体只读。 */
  readonly writable: Readonly<Record<string, PgColumn>>;
  /** create 必填的 payload 键（对应 NOT NULL 且无默认值的列）。 */
  readonly requiredOnCreate: readonly string[];
  readonly deletion: SyncDeletion;
  /** 只读实体（`execution_logs` 追加式）：一切写操作判成拒绝。 */
  readonly readOnly: boolean;
}

const neverDeleted = (): boolean => false;

/** `deleted_at` 软删的墓碑判据。 */
const softDeleted = (row: PlainRow): boolean =>
  row['deletedAt'] !== null && row['deletedAt'] !== undefined;

/** `schedule_blocks` 的状态即墓碑判据。 */
const cancelled = (row: PlainRow): boolean => row['status'] === 'cancelled';

/**
 * 实体注册表。
 *
 * 顺序即"同刻变更"的兜底顺序无关——排序统一由 `(changeAt, id)` 决定，这里只是枚举。
 */
export const SYNC_ENTITY_SPECS: readonly SyncEntitySpec[] = [
  {
    entityType: 'life_area',
    table: lifeAreas,
    idColumn: lifeAreas.id,
    userIdColumn: lifeAreas.userId,
    changeAt: sql`coalesce(${lifeAreas.updatedAt}, ${lifeAreas.createdAt})`,
    changeAtKey: 'updatedAt',
    versionColumn: lifeAreas.version,
    deletedOf: neverDeleted,
    // `deleted_at` 不列为可写：归档走 `isArchived`，而 `deleted_at` 在本实体没有语义。
    writable: {
      name: lifeAreas.name,
      colorKey: lifeAreas.colorKey,
      sortOrder: lifeAreas.sortOrder,
      isDefault: lifeAreas.isDefault,
      isArchived: lifeAreas.isArchived,
    },
    requiredOnCreate: ['name', 'colorKey', 'sortOrder'],
    deletion: 'unsupported',
    readOnly: false,
  },
  {
    entityType: 'goal',
    table: goals,
    idColumn: goals.id,
    userIdColumn: goals.userId,
    changeAt: sql`coalesce(${goals.updatedAt}, ${goals.createdAt})`,
    changeAtKey: 'updatedAt',
    versionColumn: goals.version,
    deletedOf: neverDeleted,
    writable: {
      lifeAreaId: goals.lifeAreaId,
      name: goals.name,
      reason: goals.reason,
      status: goals.status,
      startDate: goals.startDate,
      targetDate: goals.targetDate,
      resultMetric: goals.resultMetric,
    },
    requiredOnCreate: ['name'],
    deletion: 'unsupported',
    readOnly: false,
  },
  {
    entityType: 'action',
    table: actions,
    idColumn: actions.id,
    userIdColumn: actions.userId,
    changeAt: sql`coalesce(${actions.updatedAt}, ${actions.createdAt})`,
    changeAtKey: 'updatedAt',
    versionColumn: actions.version,
    deletedOf: softDeleted,
    writable: {
      goalId: actions.goalId,
      name: actions.name,
      minimumVersion: actions.minimumVersion,
      targetFrequency: actions.targetFrequency,
      estimatedMinutes: actions.estimatedMinutes,
      status: actions.status,
    },
    requiredOnCreate: ['goalId', 'name'],
    deletion: 'soft-delete',
    readOnly: false,
  },
  {
    entityType: 'task',
    table: tasks,
    idColumn: tasks.id,
    userIdColumn: tasks.userId,
    changeAt: sql`coalesce(${tasks.updatedAt}, ${tasks.createdAt})`,
    changeAtKey: 'updatedAt',
    versionColumn: tasks.version,
    deletedOf: softDeleted,
    writable: {
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
    },
    requiredOnCreate: ['title'],
    deletion: 'soft-delete',
    readOnly: false,
  },
  {
    entityType: 'routine',
    table: routines,
    idColumn: routines.id,
    userIdColumn: routines.userId,
    changeAt: sql`coalesce(${routines.updatedAt}, ${routines.createdAt})`,
    changeAtKey: 'updatedAt',
    versionColumn: routines.version,
    deletedOf: softDeleted,
    writable: {
      lifeAreaId: routines.lifeAreaId,
      name: routines.name,
      recurrenceRule: routines.recurrenceRule,
      anchorTime: routines.anchorTime,
      timezone: routines.timezone,
    },
    requiredOnCreate: ['name', 'recurrenceRule', 'timezone'],
    deletion: 'soft-delete',
    readOnly: false,
  },
  {
    entityType: 'routine_step',
    table: routineSteps,
    idColumn: routineSteps.id,
    userIdColumn: routineSteps.userId,
    changeAt: sql`coalesce(${routineSteps.updatedAt}, ${routineSteps.createdAt})`,
    changeAtKey: 'updatedAt',
    versionColumn: routineSteps.version,
    deletedOf: softDeleted,
    writable: {
      routineId: routineSteps.routineId,
      title: routineSteps.title,
      position: routineSteps.position,
      estimatedMinutes: routineSteps.estimatedMinutes,
      minimumVersion: routineSteps.minimumVersion,
    },
    requiredOnCreate: ['routineId', 'title', 'position'],
    deletion: 'soft-delete',
    readOnly: false,
  },
  {
    entityType: 'schedule_block',
    table: scheduleBlocks,
    idColumn: scheduleBlocks.id,
    userIdColumn: scheduleBlocks.userId,
    changeAt: sql`coalesce(${scheduleBlocks.updatedAt}, ${scheduleBlocks.createdAt})`,
    changeAtKey: 'updatedAt',
    versionColumn: scheduleBlocks.version,
    deletedOf: cancelled,
    writable: {
      taskId: scheduleBlocks.taskId,
      actionId: scheduleBlocks.actionId,
      routineId: scheduleBlocks.routineId,
      routineStepId: scheduleBlocks.routineStepId,
      startsAtUtc: scheduleBlocks.startsAtUtc,
      endsAtUtc: scheduleBlocks.endsAtUtc,
      timezone: scheduleBlocks.timezone,
      source: scheduleBlocks.source,
      status: scheduleBlocks.status,
      conflictState: scheduleBlocks.conflictState,
    },
    requiredOnCreate: ['startsAtUtc', 'endsAtUtc', 'timezone'],
    deletion: 'cancel',
    readOnly: false,
  },
  {
    entityType: 'fixed_commitment',
    table: fixedCommitments,
    idColumn: fixedCommitments.id,
    userIdColumn: fixedCommitments.userId,
    changeAt: sql`coalesce(${fixedCommitments.updatedAt}, ${fixedCommitments.createdAt})`,
    changeAtKey: 'updatedAt',
    versionColumn: fixedCommitments.version,
    deletedOf: softDeleted,
    writable: {
      title: fixedCommitments.title,
      templateId: fixedCommitments.templateId,
      localDate: fixedCommitments.localDate,
      startsAtUtc: fixedCommitments.startsAtUtc,
      endsAtUtc: fixedCommitments.endsAtUtc,
      startsAtLocal: fixedCommitments.startsAtLocal,
      durationMinutes: fixedCommitments.durationMinutes,
      timezone: fixedCommitments.timezone,
      recurrenceRule: fixedCommitments.recurrenceRule,
    },
    requiredOnCreate: ['title', 'durationMinutes', 'timezone'],
    deletion: 'soft-delete',
    readOnly: false,
  },
  {
    entityType: 'execution_log',
    table: executionLogs,
    idColumn: executionLogs.id,
    userIdColumn: executionLogs.userId,
    // 追加式表没有 `updated_at`：变更时刻就是创建时刻。
    changeAt: sql`${executionLogs.createdAt}`,
    changeAtKey: 'createdAt',
    versionColumn: null,
    deletedOf: neverDeleted,
    writable: {},
    requiredOnCreate: [],
    deletion: 'unsupported',
    readOnly: true,
  },
];

/** 按客户端给出的类型字符串查表；未注册返回 `null`（调用方判成拒绝）。 */
export function findEntitySpec(entityType: string): SyncEntitySpec | null {
  return SYNC_ENTITY_SPECS.find((spec) => spec.entityType === entityType) ?? null;
}

/** 行 → 对外 payload：`Date` 转 ISO 串、去掉 `userId`，其余原样。 */
export function serializeRow(row: PlainRow): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'userId') {
      continue;
    }
    payload[key] = value instanceof Date ? value.toISOString() : value;
  }
  return payload;
}

/** 行 → 版本号；追加式表恒为 1。 */
export function readVersion(spec: SyncEntitySpec, row: PlainRow): number {
  return spec.versionColumn === null ? 1 : Number(row['version']);
}

/** 行 → 变更时刻。 */
export function readChangeAt(spec: SyncEntitySpec, row: PlainRow): Date {
  const value = row[spec.changeAtKey];
  return value instanceof Date ? value : new Date(String(value));
}

/** 把查询返回行收窄成通用形态（查询结果的键是列属性名，取值类型由列决定）。 */
export function asPlainRow(value: unknown): PlainRow {
  return value as Record<string, unknown>;
}

/**
 * payload 里**一律忽略**的键。
 *
 * 客户端常把 pull 拿到的整个 payload 原样回传，里面必然带着这些由服务端掌握的字段：
 * `id`/`userId` 由操作自身与服务端决定，`version`/`createdAt`/`updatedAt` 由持久化
 * 层维护，`deletedAt` 属删除语义（必须走 `delete` 操作，不能靠写字段实现"顺手删除"）。
 * 把它们当作"未知字段"拒绝会让正常回传无法通过，所以显式忽略。
 */
const RESERVED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'id',
  'userId',
  'version',
  'createdAt',
  'updatedAt',
  'deletedAt',
]);

/** 字段归一化结果：`ok: false` 时给出可回传的拒绝原因。 */
export type ColumnValuesResult =
  | { readonly ok: true; readonly values: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * 把 payload 归一化成可直接写库的列值。
 *
 * 只做一件"应用层做不到"的事：把 JSON 里的 ISO 时间串还原成 `Date`——时间戳列是
 * `mode: 'date'`，塞字符串会被驱动当字面量处理。其余类型交给数据库与驱动。
 */
export function buildColumnValues(
  spec: SyncEntitySpec,
  payload: Readonly<Record<string, unknown>>,
): ColumnValuesResult {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (RESERVED_PAYLOAD_KEYS.has(key)) {
      continue;
    }
    const column = spec.writable[key];
    if (column === undefined) {
      return { ok: false, reason: `实体 ${spec.entityType} 不接受字段 ${key}` };
    }
    if (
      column.columnType === 'PgTimestamp' &&
      column.dataType === 'date' &&
      typeof value === 'string'
    ) {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        return { ok: false, reason: `字段 ${key} 不是合法的时间` };
      }
      values[key] = parsed;
      continue;
    }
    values[key] = value;
  }
  return { ok: true, values };
}
