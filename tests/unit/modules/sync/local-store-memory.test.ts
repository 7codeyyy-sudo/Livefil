/**
 * LocalStore 事务与幂等规则（测试点 11）。
 *
 * 使用内存实现验证端口契约：
 * - 一次读改写落在同一事务内（内存实现为单线程，天然原子）
 * - markSnapshotSynced 对不存在/已 synced 静默忽略
 * - applyRemoteChange 对 pending 快照一律 ignored
 */
import { describe, expect, it } from 'vitest';
import { createMemoryLocalStore } from '@/modules/sync/infrastructure/local-store.memory.ts';
import type {
  EntitySnapshotRecord,
  PendingOperationRecord,
  RemoteChangeInput,
} from '@/modules/sync/domain/local-store.ts';

function snapshot(overrides: Partial<EntitySnapshotRecord> = {}): EntitySnapshotRecord {
  return {
    entityType: 'task',
    entityId: 't1',
    version: 1,
    deleted: false,
    payload: { title: 'task' },
    changeAt: Date.now(),
    syncState: 'synced',
    ...overrides,
  };
}

function operation(overrides: Partial<PendingOperationRecord> = {}): PendingOperationRecord {
  return {
    operationId: 'op-1',
    entityType: 'task',
    entityId: 't1',
    operationType: 'update',
    baseVersion: 1,
    payload: { title: 'new' },
    createdAt: Date.now(),
    status: 'pending',
    rejectReason: null,
    conflictId: null,
    conflictServerVersion: null,
    conflictServerPayload: null,
    ...overrides,
  };
}

describe('LocalStore（内存实现）', () => {
  it('markSnapshotSynced 对不存在/已 synced 静默忽略', async () => {
    const store = createMemoryLocalStore();

    await expect(
      store.markSnapshotSynced({
        entityType: 'task',
        entityId: 'missing',
        version: 2,
        changeAt: Date.now(),
      }),
    ).resolves.toBeUndefined();

    const synced = snapshot();
    await store.putSnapshot(synced);
    await expect(
      store.markSnapshotSynced({
        entityType: 'task',
        entityId: 't1',
        version: 2,
        changeAt: Date.now(),
      }),
    ).resolves.toBeUndefined();

    const updated = await store.readSnapshot('task', 't1');
    expect(updated?.syncState).toBe('synced');
  });

  it('applyRemoteChange 对 pending 快照一律 ignored', async () => {
    const store = createMemoryLocalStore();
    const pending = snapshot({ version: 0, syncState: 'pending' });
    await store.putSnapshot(pending);

    const change: RemoteChangeInput = {
      entityType: 'task',
      entityId: 't1',
      version: 5,
      deleted: false,
      payload: { title: 'remote' },
      changeAt: Date.now(),
    };

    const outcome = await store.applyRemoteChange(change);
    expect(outcome).toBe('ignored');

    const current = await store.readSnapshot('task', 't1');
    expect(current?.syncState).toBe('pending');
    expect(current?.payload.title).toBe('task');
  });

  it('删除操作级联清理子行', async () => {
    const store = createMemoryLocalStore();
    await store.putSnapshot(
      snapshot({ entityType: 'routine', entityId: 'r1', payload: { id: 'r1' } }),
    );
    await store.putSnapshot(
      snapshot({
        entityType: 'routine_step',
        entityId: 's1',
        payload: { id: 's1', routineId: 'r1' },
      }),
    );
    await store.enqueueOperation(operation({ entityType: 'routine_step', entityId: 's1' }));

    const outcome = await store.applyRemoteChange({
      entityType: 'routine',
      entityId: 'r1',
      version: 1,
      deleted: true,
      payload: { id: 'r1' },
      changeAt: Date.now(),
    });

    expect(outcome).toBe('purged');
    expect(await store.readSnapshot('routine', 'r1')).toBeNull();
    expect(await store.readSnapshot('routine_step', 's1')).toBeNull();
    const ops = await store.listOperations();
    expect(ops.find((o) => o.entityId === 's1')).toBeUndefined();
  });
});
