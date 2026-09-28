/**
 * 离线新建入队（测试点 10 缺陷 2 回归）。
 */
import { describe, expect, it } from 'vitest';

import { sendJson, setSyncWriteSink, type SyncWriteDescriptor } from 'app/(app)/_lib/api-client';

function createTestSink() {
  const calls: SyncWriteDescriptor[] = [];
  return {
    calls,
    sink: async (descriptor: SyncWriteDescriptor) => {
      calls.push({ ...descriptor });
    },
  };
}

describe('离线新建入队（测试点 10 缺陷 2 回归）', () => {
  it('断网 POST 白名单集合 → 入队 create、页面立现该项', async () => {
    const { calls, sink } = createTestSink();
    setSyncWriteSink(sink);

    const payload = { title: '离线任务', status: 'inbox' };
    const envelope = await sendJson<{ id: string; version: number }>(
      'POST',
      '/api/v1/tasks',
      payload,
    );

    expect(calls).toHaveLength(1);
    const firstCall = calls[0];
    if (!firstCall) {
      throw new Error('本用例要求 sink 恰好收到 1 条 descriptor');
    }
    expect(firstCall).toMatchObject({
      entityType: 'task',
      operationType: 'create',
      baseVersion: null,
      payload: { ...payload },
    });
    expect(firstCall.entityId).toBeTruthy();

    expect(envelope.data).toEqual({
      id: firstCall.entityId,
      version: 0,
      ...payload,
    });
  });

  it('POST /tasks/batch、POST /tasks/{id}/archive 带更深路径的 POST 不入队', async () => {
    const { calls, sink } = createTestSink();
    setSyncWriteSink(sink);

    await expect(sendJson('POST', '/api/v1/tasks/batch', { ids: [] })).rejects.toBeDefined();
    await expect(sendJson('POST', '/api/v1/tasks/123/archive', {})).rejects.toBeDefined();

    expect(calls).toHaveLength(0);
  });

  it('非白名单集合的 POST 不入队', async () => {
    const { calls, sink } = createTestSink();
    setSyncWriteSink(sink);

    await expect(sendJson('POST', '/api/v1/unknown', { foo: 'bar' })).rejects.toBeDefined();

    expect(calls).toHaveLength(0);
  });
});
