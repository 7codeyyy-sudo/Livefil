/**
 * push 用例回归（测试点 3、4、5、6）。
 */
import { describe, expect, it } from 'vitest';
import {
  PushOperationsUseCase,
  SYNC_IDEMPOTENCY_KEY_PREFIX,
} from '@/modules/sync/application/push-operations.ts';
import { ConflictService } from '@/modules/sync/application/conflict-service.ts';
import type { SyncApplyPort } from '@/modules/sync/domain/sync-repository.ts';
import type { SyncIdempotencyPort } from '@/modules/sync/domain/idempotency-port.ts';
import { ValidationError } from '@/shared/errors/app-error.ts';

function fakeApply(
  outcomes: Array<{
    outcome: 'applied' | 'conflict' | 'rejected';
    version?: number;
    reason?: string;
    serverVersion?: number;
    serverPayload?: Record<string, unknown>;
  }>,
): SyncApplyPort {
  let idx = 0;
  return {
    apply: async () => {
      const next = outcomes[idx++] ?? { outcome: 'applied' as const, version: 1 };
      return next;
    },
  } as SyncApplyPort;
}

function fakeIdempotency(claimOutcome: 'claimed' | 'replay' = 'claimed'): SyncIdempotencyPort {
  return {
    claim: async () => ({ outcome: claimOutcome, snapshot: null }),
    complete: async () => {},
    release: async () => {},
  } as SyncIdempotencyPort;
}

describe('PushOperationsUseCase', () => {
  it('replay 直接返回 already_applied', async () => {
    let capturedKey = '';
    const useCase = new PushOperationsUseCase({
      apply: fakeApply([{ outcome: 'applied', version: 3 }]),
      idempotency: {
        async claim(_userId: string, key: string) {
          capturedKey = key;
          return { outcome: 'replay', snapshot: { entityType: 'task', entityId: 'a', version: 2 } };
        },
        async complete() {},
        async release() {},
      },
      conflicts: new ConflictService({
        conflicts: {
          async record() {
            return { id: 'conflict-1' };
          },
        } as unknown as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        apply: fakeApply([{ outcome: 'applied', version: 3 }]),
      }),
    });

    const results = await useCase.execute('user-1', [
      {
        operationId: 'op-a',
        entityType: 'task',
        entityId: 'a',
        operationType: 'update',
        baseVersion: 1,
        payload: {},
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('already_applied');
    expect((results[0] as { version?: number } | null)?.version).toBe(2);
    expect(capturedKey).toBe(`${SYNC_IDEMPOTENCY_KEY_PREFIX}op-a`);
  });

  it('claimed + applied 正常写入', async () => {
    const useCase = new PushOperationsUseCase({
      apply: fakeApply([{ outcome: 'applied', version: 3 }]),
      idempotency: fakeIdempotency('claimed'),
      conflicts: new ConflictService({
        conflicts: {
          async record() {
            return { id: 'conflict-1' };
          },
        } as unknown as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        apply: fakeApply([{ outcome: 'applied', version: 3 }]),
      }),
    });

    const results = await useCase.execute('user-1', [
      {
        operationId: 'op-1',
        entityType: 'task',
        entityId: 'a',
        operationType: 'update',
        baseVersion: 1,
        payload: {},
      },
    ]);
    expect(results[0]?.status).toBe('applied');
    expect((results[0] as { version?: number } | null)?.version).toBe(3);
  });

  it('同 operationId 异指纹 → rejected', async () => {
    const useCase = new PushOperationsUseCase({
      apply: fakeApply([{ outcome: 'applied', version: 1 }]),
      idempotency: {
        async claim() {
          throw new ValidationError('fingerprint mismatch');
        },
      } as unknown as SyncIdempotencyPort,
      conflicts: new ConflictService({
        conflicts: {
          async record() {
            return { id: 'conflict-1' };
          },
        } as unknown as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        apply: fakeApply([{ outcome: 'applied', version: 1 }]),
      }),
    });

    const results = await useCase.execute('user-1', [
      {
        operationId: 'op-x',
        entityType: 'task',
        entityId: 'a',
        operationType: 'update',
        baseVersion: 1,
        payload: {},
      },
    ]);
    expect(results[0]?.status).toBe('rejected');
    expect((results[0] as { reason?: string } | null)?.reason).toContain('fingerprint');
  });

  it('conflict 条目释放占位，重试重评估', async () => {
    let releaseCalled = false;
    const useCase = new PushOperationsUseCase({
      apply: fakeApply([
        { outcome: 'conflict', serverVersion: 5, serverPayload: { title: 'server' } },
      ]),
      idempotency: {
        async claim() {
          return { outcome: 'claimed' };
        },
        async complete() {},
        async release() {
          releaseCalled = true;
        },
      } as unknown as SyncIdempotencyPort,
      conflicts: new ConflictService({
        conflicts: {
          async record() {
            return { id: 'conflict-1' };
          },
        } as unknown as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        apply: fakeApply([
          { outcome: 'conflict', serverVersion: 5, serverPayload: { title: 'server' } },
        ]),
      }),
    });

    const results = await useCase.execute('user-1', [
      {
        operationId: 'op-c',
        entityType: 'task',
        entityId: 'a',
        operationType: 'update',
        baseVersion: 1,
        payload: { title: 'local' },
      },
    ]);

    expect(results[0]?.status).toBe('conflict');
    expect((results[0] as { conflictId?: string } | null)?.conflictId).toBe('conflict-1');
    expect(releaseCalled).toBe(true);
  });
});
