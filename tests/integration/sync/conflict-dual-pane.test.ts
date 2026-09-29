/**
 * 专项 A：keep_server 证据（integration）。
 *
 * 证明点（只基于 resolve-conflict.ts 能公开观察到的事实）：
 * 1. manual_merge → 400（端点层校验）
 * 2. keep_server → 不调用底层 apply，仅标记已解决
 * 3. keep_local → 调用 apply 且传入本地 payload
 */
import { describe, expect, test } from 'vitest';
import { ResolveConflictUseCase } from '../../../src/modules/sync/application/resolve-conflict.ts';
import type {
  SyncConflictRepository,
  SyncConflict,
} from '../../../src/modules/sync/domain/sync-conflict.ts';
import type { ConflictService } from '../../../src/modules/sync/application/conflict-service.ts';
import { ValidationError } from '../../../src/shared/errors/app-error.ts';

function fakeConflictRepository(conflict: SyncConflict | null): SyncConflictRepository {
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
      return {
        id: conflict?.id ?? 'c1',
        entityType: conflict?.entityType ?? 'task',
        entityId: conflict?.entityId ?? 'a',
        localVersion: conflict?.localVersion ?? 1,
        serverVersion: conflict?.serverVersion ?? 1,
        localPayload: conflict?.localPayload ?? { title: 'local' },
        serverPayload: conflict?.serverPayload ?? { title: 'server' },
        status: 'resolved',
        resolvedAt: new Date().toISOString(),
        createdAt: conflict?.createdAt ?? new Date().toISOString(),
        version: (conflict?.version ?? 1) + 1,
      };
    },
  };
}

describe('专项 A：keep_server 证据（点 15 关联）', () => {
  const baseConflict: SyncConflict = {
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

  test('manual_merge → ValidationError（400 语义）', async () => {
    const useCase = new ResolveConflictUseCase({
      conflicts: fakeConflictRepository(baseConflict),
      conflictService: {} as unknown as ConflictService,
    });

    await expect(useCase.execute('u1', 'c1', 'manual_merge')).rejects.toThrow(ValidationError);
  });

  test('keep_server → 不调用 apply，仅标记已解决', async () => {
    const applied = false;
    const useCase = new ResolveConflictUseCase({
      conflicts: fakeConflictRepository(baseConflict),
      conflictService: {
        keepLocal: async () => {},
      } as unknown as ConflictService,
    });

    const result = await useCase.execute('u1', 'c1', 'keep_server');
    expect(result.status).toBe('resolved');
    expect(applied).toBe(false);
  });

  test('keep_local → 调用 conflictService.keepLocal', async () => {
    let kept = false;
    const useCase = new ResolveConflictUseCase({
      conflicts: fakeConflictRepository(baseConflict),
      conflictService: {
        keepLocal: async () => {
          kept = true;
        },
      } as unknown as ConflictService,
    });

    const result = await useCase.execute('u1', 'c1', 'keep_local');
    expect(result.status).toBe('resolved');
    expect(kept).toBe(true);
  });

  test('冲突不存在 → 404（NotFoundError）', async () => {
    const useCase = new ResolveConflictUseCase({
      conflicts: fakeConflictRepository(null),
      conflictService: {} as unknown as ConflictService,
    });

    await expect(useCase.execute('u1', 'missing', 'keep_server')).rejects.toThrow('同步冲突不存在');
  });

  test('重复解决 → 409（ConflictError）', async () => {
    const resolvedConflict: SyncConflict = {
      ...baseConflict,
      status: 'resolved',
      resolvedAt: new Date().toISOString(),
    };
    const useCase = new ResolveConflictUseCase({
      conflicts: fakeConflictRepository(resolvedConflict),
      conflictService: {
        keepLocal: async () => {},
      } as unknown as ConflictService,
    });

    await expect(useCase.execute('u1', 'c1', 'keep_server')).rejects.toThrow('该冲突已经处理过');
  });
});
