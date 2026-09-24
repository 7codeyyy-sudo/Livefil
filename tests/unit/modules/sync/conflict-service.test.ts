/**
 * 冲突服务回归（测试点 8）。
 */
import { describe, expect, it } from 'vitest';
import { ConflictService } from '@/modules/sync/application/conflict-service.ts';
import type { SyncConflict, SyncConflictRepository } from '@/modules/sync/domain/sync-conflict.ts';
import { ValidationError } from '@/shared/errors/app-error.ts';

function fakeRepository(conflict: SyncConflict | null): SyncConflictRepository {
  return {
    async record() {
      return (
        conflict ?? {
          id: 'c1',
          entityType: 'task',
          entityId: 'a',
          localVersion: 1,
          serverVersion: 1,
          localPayload: { title: 'local' },
          serverPayload: { title: 'server' },
          status: 'pending',
          resolvedAt: null,
          createdAt: new Date().toISOString(),
          version: 1,
        }
      );
    },
    async findById() {
      return conflict;
    },
    async markResolved() {
      return (
        conflict ?? {
          id: 'c1',
          entityType: 'task',
          entityId: 'a',
          localVersion: 1,
          serverVersion: 1,
          localPayload: { title: 'local' },
          serverPayload: { title: 'server' },
          status: 'resolved',
          resolvedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          version: 2,
        }
      );
    },
  };
}

describe('ConflictService', () => {
  it('keep_local 以本地 payload 强制覆盖服务端', async () => {
    let appliedPayload: Record<string, unknown> | null = null;
    const service = new ConflictService({
      conflicts: fakeRepository({
        id: 'c1',
        entityType: 'task',
        entityId: 'a',
        localVersion: 1,
        serverVersion: 1,
        localPayload: { title: 'local' },
        serverPayload: { title: 'server' },
        status: 'pending',
        resolvedAt: null,
        createdAt: new Date().toISOString(),
        version: 1,
      }),
      apply: {
        async apply(
          _userId: string,
          input: {
            entityType: string;
            entityId: string;
            operationType: string;
            baseVersion: number | null;
            payload: Record<string, unknown>;
          },
        ) {
          appliedPayload = input.payload;
          return { outcome: 'applied' as const, version: 10 };
        },
      },
    });

    const conflict: SyncConflict = {
      id: 'c1',
      entityType: 'task',
      entityId: 'a',
      localVersion: 1,
      serverVersion: 1,
      localPayload: { title: 'local' },
      serverPayload: { title: 'server' },
      status: 'pending',
      resolvedAt: null,
      createdAt: new Date().toISOString(),
      version: 1,
    };

    await service.keepLocal('u1', conflict);

    expect(appliedPayload).toEqual({ title: 'local' });
  });

  it('keep_local 无条件覆盖（baseVersion: null）', async () => {
    const service = new ConflictService({
      conflicts: fakeRepository({
        id: 'c1',
        entityType: 'task',
        entityId: 'a',
        localVersion: 1,
        serverVersion: 1,
        localPayload: { title: 'local' },
        serverPayload: { title: 'server' },
        status: 'pending',
        resolvedAt: null,
        createdAt: new Date().toISOString(),
        version: 1,
      }),
      apply: {
        async apply() {
          return { outcome: 'applied' as const, version: 10 };
        },
      },
    });

    const conflict: SyncConflict = {
      id: 'c1',
      entityType: 'task',
      entityId: 'a',
      localVersion: 1,
      serverVersion: 1,
      localPayload: { title: 'local' },
      serverPayload: { title: 'server' },
      status: 'pending',
      resolvedAt: null,
      createdAt: new Date().toISOString(),
      version: 1,
    };

    await expect(service.keepLocal('u1', conflict)).resolves.toBeUndefined();
  });

  it('localPayload 为 null 抛 ValidationError', async () => {
    const service = new ConflictService({
      conflicts: fakeRepository(null),
      apply: {
        async apply() {
          return { outcome: 'applied' as const, version: 1 };
        },
      },
    });

    const conflict: SyncConflict = {
      id: 'c1',
      entityType: 'task',
      entityId: 'a',
      localVersion: null,
      serverVersion: 1,
      localPayload: null,
      serverPayload: {},
      status: 'pending',
      resolvedAt: null,
      createdAt: new Date().toISOString(),
      version: 1,
    };

    await expect(service.keepLocal('u1', conflict)).rejects.toThrow(ValidationError);
  });
});
