/**
 * push 的写入实现（SYNC-003，《接口文档》§12.1.1）。
 *
 * ## 乐观并发只有一种写法
 *
 * 版本递增与"WHERE version = 期望值"必须在**同一条语句**里完成：拆成
 * "先读版本—再写"的话，两个并发写会同时通过检查（公共字段的既定纪律，
 * 与 `task-repository.drizzle.ts` 同）。
 *
 * ## 版本冲突要带上服务端当前内容
 *
 * CAS 失败时不能只回一个"冲突了"：用户要在界面上对比"本地 vs 服务端"才能二选，
 * 所以这里顺手把命中行的快照序列化出去——由本层读出比让应用层再查一次更省一次往返，
 * 也避免了"冲突记录里的服务端内容"与判定冲突的那一行不是同一个版本。
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';

import type {
  SyncApplyOperation,
  SyncApplyOutcome,
  SyncApplyPort,
} from '../domain/sync-repository.ts';
import {
  asPlainRow,
  buildColumnValues,
  findEntitySpec,
  readVersion,
  serializeRow,
  type PlainRow,
  type SyncEntitySpec,
} from './sync-entities.ts';

/** PostgreSQL 的外键约束冲突。 */
const FOREIGN_KEY_VIOLATION = '23503';

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === FOREIGN_KEY_VIOLATION
  );
}

function rejected(reason: string): SyncApplyOutcome {
  return { outcome: 'rejected', reason };
}

/** 读服务端当前行（含已软删的行——冲突要展示的就是"当前服务端的样子"）。 */
async function readCurrent(
  db: Database,
  spec: SyncEntitySpec,
  userId: string,
  entityId: string,
): Promise<PlainRow | null> {
  const rows = await db
    .select()
    .from(spec.table)
    // 作用域谓词在这里也必须出现：冲突回读同样不能越域（IAM-004）。
    .where(and(eq(spec.userIdColumn, userId), eq(spec.idColumn, entityId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : asPlainRow(row);
}

/** 更新命中零行时的归因：行不在（拒绝）还是版本对不上（冲突）。 */
async function explainUpdateMiss(
  db: Database,
  spec: SyncEntitySpec,
  userId: string,
  entityId: string,
): Promise<SyncApplyOutcome> {
  const current = await readCurrent(db, spec, userId, entityId);
  if (current === null) {
    return rejected('实体不存在或不属于当前用户');
  }
  return {
    outcome: 'conflict',
    serverVersion: readVersion(spec, current),
    serverPayload: serializeRow(current),
  };
}

/** 版本匹配条件；`baseVersion` 为 `null` 时不做版本校验（`keep_local` 的强制覆盖）。 */
function versionCondition(spec: SyncEntitySpec, baseVersion: number | null): readonly SQL[] {
  if (baseVersion === null || spec.versionColumn === null) {
    return [];
  }
  return [eq(spec.versionColumn, baseVersion)];
}

/** create：客户端自带 UUID，冲突时回读并交回服务端当前内容。 */
async function createEntity(
  db: Database,
  spec: SyncEntitySpec,
  userId: string,
  operation: SyncApplyOperation,
): Promise<SyncApplyOutcome> {
  if (spec.readOnly) {
    return rejected(`实体 ${spec.entityType} 为追加式只读实体，不支持 create`);
  }

  const built = buildColumnValues(spec, operation.payload);
  if (!built.ok) {
    return rejected(built.reason);
  }
  const missing = spec.requiredOnCreate.filter((key) => built.values[key] === undefined);
  if (missing.length > 0) {
    return rejected(`缺少必填字段：${missing.join('、')}`);
  }

  let inserted: readonly unknown[];
  try {
    inserted = await db
      .insert(spec.table)
      .values({ id: operation.entityId, userId, ...built.values })
      // 不带冲突目标：覆盖该表上**所有**唯一约束（`ON CONFLICT DO NOTHING` 的语义）。
      .onConflictDoNothing()
      .returning();
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return rejected('关联实体不存在，请先同步其上游实体');
    }
    throw error;
  }

  const row = inserted[0];
  if (row !== undefined) {
    const plain = asPlainRow(row);
    return { outcome: 'applied', version: readVersion(spec, plain) };
  }

  const current = await readCurrent(db, spec, userId, operation.entityId);
  if (current === null) {
    // 唯一约束挡住了插入，但按 (userId, id) 又读不到：命中别的用户的行，或撞了
    // 其它唯一键（如 `routine_steps` 的 (routine_id, position)）。
    return rejected('实体 ID 已被占用，或与既有数据违反唯一约束');
  }
  return {
    outcome: 'conflict',
    serverVersion: readVersion(spec, current),
    serverPayload: serializeRow(current),
  };
}

/** update：CAS 局部更新。 */
async function updateEntity(
  db: Database,
  spec: SyncEntitySpec,
  userId: string,
  operation: SyncApplyOperation,
): Promise<SyncApplyOutcome> {
  if (spec.readOnly) {
    return rejected(`实体 ${spec.entityType} 为追加式只读实体，不支持 update`);
  }
  const versionColumn = spec.versionColumn;
  if (versionColumn === null) {
    return rejected(`实体 ${spec.entityType} 没有版本列，不支持 update`);
  }

  const built = buildColumnValues(spec, operation.payload);
  if (!built.ok) {
    return rejected(built.reason);
  }
  if (Object.keys(built.values).length === 0) {
    return rejected('payload 中没有可写字段');
  }

  const rows = await db
    .update(spec.table)
    .set({ ...built.values, version: sql`${versionColumn} + 1` })
    .where(
      and(
        eq(spec.userIdColumn, userId),
        eq(spec.idColumn, operation.entityId),
        ...versionCondition(spec, operation.baseVersion),
      ),
    )
    .returning();

  const row = rows[0];
  if (row === undefined) {
    return explainUpdateMiss(db, spec, userId, operation.entityId);
  }
  return { outcome: 'applied', version: readVersion(spec, asPlainRow(row)) };
}

/** delete：软删列或取消状态，同样过 CAS。 */
async function deleteEntity(
  db: Database,
  spec: SyncEntitySpec,
  userId: string,
  operation: SyncApplyOperation,
): Promise<SyncApplyOutcome> {
  if (spec.deletion === 'unsupported') {
    return rejected(`实体 ${spec.entityType} 没有删除语义，不支持 delete`);
  }
  const versionColumn = spec.versionColumn;
  if (versionColumn === null) {
    return rejected(`实体 ${spec.entityType} 没有版本列，不支持 delete`);
  }

  const patch: Record<string, unknown> =
    spec.deletion === 'cancel' ? { status: 'cancelled' } : { deletedAt: new Date() };

  const rows = await db
    .update(spec.table)
    .set({ ...patch, version: sql`${versionColumn} + 1` })
    .where(
      and(
        eq(spec.userIdColumn, userId),
        eq(spec.idColumn, operation.entityId),
        ...versionCondition(spec, operation.baseVersion),
      ),
    )
    .returning();

  const row = rows[0];
  if (row === undefined) {
    return explainUpdateMiss(db, spec, userId, operation.entityId);
  }
  return { outcome: 'applied', version: readVersion(spec, asPlainRow(row)) };
}

export function createSyncApplyPort(db: Database): SyncApplyPort {
  return {
    async apply(userId: string, operation: SyncApplyOperation): Promise<SyncApplyOutcome> {
      const spec = findEntitySpec(operation.entityType);
      if (spec === null) {
        return rejected(`不支持的实体类型：${operation.entityType}`);
      }

      switch (operation.operationType) {
        case 'create':
          return createEntity(db, spec, userId, operation);
        case 'update':
          return updateEntity(db, spec, userId, operation);
        case 'delete':
          return deleteEntity(db, spec, userId, operation);
      }
    },
  };
}
