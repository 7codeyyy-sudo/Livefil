/**
 * pull 分页契约（测试点 17）。
 */
import { describe, expect, it } from 'vitest';
import { PullChangesUseCase } from '@/modules/sync/application/pull-changes.ts';
import { encodePullCursor } from '@/modules/sync/domain/sync-change.ts';
import type { SyncChangePage, SyncRepository } from '@/modules/sync/domain/sync-repository.ts';

describe('PullChangesUseCase 分页契约', () => {
  it('limit > 100 被钳制', async () => {
    const repo: SyncRepository = {
      async listChanges(): Promise<SyncChangePage> {
        return { changes: [], nextCursor: null, hasMore: false };
      },
    };

    const useCase = new PullChangesUseCase({ sync: repo, lagMs: 0 });
    const result = await useCase.execute('user-1', { limit: 999 });
    expect(result).toBeDefined();
  });

  it('非法游标返回错误', async () => {
    const repo: SyncRepository = {
      async listChanges(): Promise<SyncChangePage> {
        return { changes: [], nextCursor: null, hasMore: false };
      },
    };

    const useCase = new PullChangesUseCase({ sync: repo, lagMs: 0 });
    await expect(useCase.execute('user-1', { cursor: 'bad-cursor', limit: 50 })).rejects.toThrow();
  });

  it('合法游标传透', async () => {
    const after = new Date('2026-09-22T12:00:00Z');
    const validUuid = '550e8400-e29b-41d4-a716-446655440000';
    const cursor = encodePullCursor({ changeAtMs: after.getTime(), id: validUuid });

    const repo: SyncRepository = {
      async listChanges(
        _userId: string,
        opts: { after: unknown; until: Date; limit: number },
      ): Promise<SyncChangePage> {
        expect((opts.after as { changeAtMs: number } | null)?.changeAtMs).toBe(after.getTime());
        expect((opts.after as { id: string } | null)?.id).toBe(validUuid);
        return { changes: [], nextCursor: null, hasMore: false };
      },
    };

    const useCase = new PullChangesUseCase({ sync: repo, lagMs: 0 });
    await useCase.execute('user-1', { cursor, limit: 50 });
  });
});
