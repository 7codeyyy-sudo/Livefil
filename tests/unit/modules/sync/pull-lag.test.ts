/**
 * 安全滞后窗口防漏读（测试点 2）。
 */
import { describe, expect, it } from 'vitest';
import { PullChangesUseCase } from '@/modules/sync/application/pull-changes.ts';
import type { SyncChange } from '@/modules/sync/domain/sync-change.ts';
import type { SyncChangePage, SyncRepository } from '@/modules/sync/domain/sync-repository.ts';

function makeChange(overrides: Partial<SyncChange> = {}): SyncChange {
  return {
    entityType: 'task',
    entityId: 'a',
    version: 1,
    deleted: false,
    payload: {},
    changeAt: new Date(),
    ...overrides,
  };
}

describe('PullChangesUseCase 安全滞后窗口', () => {
  it('只返回 lag 之前提交的变更', async () => {
    const now = new Date('2026-09-22T12:00:00Z');
    const lagMs = 5_000;
    const changeA = makeChange({ entityId: 'a', changeAt: new Date(now.getTime() - 6_000) });
    const changeB = makeChange({ entityId: 'b', changeAt: new Date(now.getTime() - 2_000) });

    const repo: SyncRepository = {
      async listChanges(
        _userId: string,
        _opts: { after: unknown; until: Date; limit: number },
      ): Promise<SyncChangePage> {
        const until = _opts.until;
        const changes = [changeA, changeB].filter((c) => c.changeAt.getTime() <= until.getTime());
        return { changes, nextCursor: null, hasMore: false };
      },
    };

    const useCase = new PullChangesUseCase({ sync: repo, lagMs, now: () => now });

    const result = await useCase.execute('user-1', { limit: 50 });
    expect(result.changes.map((c) => c.entityId)).toEqual(['a']);
  });

  it('无 lag 时返回全部', async () => {
    const now = new Date('2026-09-22T12:00:00Z');
    const changes = [
      makeChange({ entityId: 'a', changeAt: new Date(now.getTime() - 10_000) }),
      makeChange({ entityId: 'b', changeAt: new Date(now.getTime() - 1_000) }),
    ];

    const repo: SyncRepository = {
      async listChanges(): Promise<SyncChangePage> {
        return { changes, nextCursor: null, hasMore: false };
      },
    };

    const useCase = new PullChangesUseCase({ sync: repo, lagMs: 0, now: () => now });

    const result = await useCase.execute('user-1', { limit: 50 });
    expect(result.changes).toHaveLength(2);
  });
});
