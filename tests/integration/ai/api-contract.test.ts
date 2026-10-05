// @vitest-environment jsdom
/**
 * A 组 · AI API 端点契约（PD-020 点 1-6，AI-004/005/006，P0）。
 *
 * 覆盖：
 * - 点 1：七端点可访问（404 以外均视为登记存在）
 * - 点 2：task-breakdown 正常/失败
 * - 点 3：schedule-suggestion 正常包络
 * - 点 4：expense-parse 成功/失败态（200+空载荷）
 * - 点 5：confirm pending→confirmed、failed→422
 * - 点 6：cancel pending→cancelled、usage 429
 *
 * 策略：MSW 拦截 /api/v1/ai/*，模拟 provider/仓储行为；不依赖数据库。
 */
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { server, enableMswServer } from '../../setup/msw-server.ts';

enableMswServer();

// ---------------------------------------------------------------------------
// 契约同形类型子集
// ---------------------------------------------------------------------------
type AiDraftStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'failed';

interface TaskBreakdownDraftData {
  readonly draftId: string;
  readonly type: 'task_breakdown';
  readonly status: AiDraftStatus;
  readonly suggestions: readonly { readonly title: string; readonly estimatedMinutes: number }[];
  readonly expiresAt: string;
}

interface ScheduleSuggestionDraftData {
  readonly draftId: string;
  readonly type: 'schedule_suggestion';
  readonly status: AiDraftStatus;
  readonly suggestions: readonly {
    readonly taskId: string;
    readonly blockStart: string;
    readonly blockEnd: string;
    readonly reason: string;
  }[];
  readonly expiresAt: string;
}

interface ExpenseParseDraftData {
  readonly draftId: string;
  readonly type: 'expense_parse';
  readonly status: AiDraftStatus;
  readonly draft: {
    readonly amountMinor: number;
    readonly currencyCode: string;
    readonly occurredOn: string;
    readonly categoryId: string | null;
    readonly note: string | null;
  } | null;
  readonly expiresAt: string;
}

interface ReviewSummaryDraftData {
  readonly draftId: string;
  readonly type: 'review_summary';
  readonly status: AiDraftStatus;
  readonly summary: {
    readonly highlights: readonly string[];
    readonly suggestions: readonly string[];
  };
  readonly expiresAt: string;
}

interface AiDraftConfirmResult {
  readonly draftId: string;
  readonly type: string;
  readonly status: AiDraftStatus;
  readonly createdIds: readonly string[];
}

interface AiDraftStatusResult {
  readonly draftId: string;
  readonly type: string;
  readonly status: AiDraftStatus;
}

interface AiUsageData {
  readonly periodStart: string;
  readonly resetAt: string;
  readonly callCount: number;
  readonly costMinor: number;
  readonly callLimit: number;
  readonly costLimitMinor: number;
  readonly remainingCalls: number;
  readonly remainingCostMinor: number;
}

function envelope<T>(data: T) {
  return { data };
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------
describe('AI API 端点契约（点 1-6）', () => {
  it('点 1：七端点可访问（200/422/429 均视为登记存在）', async () => {
    server.use(
      http.post('/api/v1/ai/drafts/task-breakdown', () =>
        HttpResponse.json(
          envelope({
            draftId: 'd1',
            type: 'task_breakdown',
            status: 'pending',
            suggestions: [],
            expiresAt: new Date().toISOString(),
          } as TaskBreakdownDraftData),
        ),
      ),
      http.post('/api/v1/ai/drafts/schedule-suggestion', () =>
        HttpResponse.json(
          envelope({
            draftId: 'd2',
            type: 'schedule_suggestion',
            status: 'pending',
            suggestions: [],
            expiresAt: new Date().toISOString(),
          } as ScheduleSuggestionDraftData),
        ),
      ),
      http.post('/api/v1/ai/drafts/expense-parse', () =>
        HttpResponse.json(
          envelope({
            draftId: 'd3',
            type: 'expense_parse',
            status: 'pending',
            draft: null,
            expiresAt: new Date().toISOString(),
          } as ExpenseParseDraftData),
        ),
      ),
      http.post('/api/v1/ai/drafts/review-summary', () =>
        HttpResponse.json(
          envelope({
            draftId: 'd4',
            type: 'review_summary',
            status: 'pending',
            summary: { highlights: [], suggestions: [] },
            expiresAt: new Date().toISOString(),
          } as ReviewSummaryDraftData),
        ),
      ),
      http.post('/api/v1/ai/drafts/:draftId/confirm', () =>
        HttpResponse.json(
          envelope({
            draftId: 'd1',
            type: 'task_breakdown',
            status: 'confirmed',
            createdIds: [],
          } as AiDraftConfirmResult),
        ),
      ),
      http.post('/api/v1/ai/drafts/:draftId/cancel', () =>
        HttpResponse.json(
          envelope({
            draftId: 'd1',
            type: 'task_breakdown',
            status: 'cancelled',
          } as AiDraftStatusResult),
        ),
      ),
      http.get('/api/v1/ai/usage', () =>
        HttpResponse.json(
          envelope({
            periodStart: '2026-10-01',
            resetAt: '2026-11-01',
            callCount: 0,
            costMinor: 0,
            callLimit: 100,
            costLimitMinor: 10000,
            remainingCalls: 100,
            remainingCostMinor: 10000,
          } as AiUsageData),
        ),
      ),
    );

    // 显式声明元素形状：不声明的话数组字面量会推出「有的成员带 body、有的不带」的
    // 联合类型，再叠加 exactOptionalPropertyTypes，`fetch` 的重载就匹配不上（TS2769）。
    type ProbeEndpoint = {
      readonly method: 'GET' | 'POST';
      readonly url: string;
      readonly body?: unknown;
    };

    const endpoints: readonly ProbeEndpoint[] = [
      { method: 'POST' as const, url: '/api/v1/ai/drafts/task-breakdown', body: { text: 'x' } },
      {
        method: 'POST' as const,
        url: '/api/v1/ai/drafts/schedule-suggestion',
        body: {
          taskIds: ['123e4567-e89b-12d3-a456-426614174000'],
          availableMinutes: 60,
          windowStart: new Date().toISOString(),
          windowEnd: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
      { method: 'POST' as const, url: '/api/v1/ai/drafts/expense-parse', body: { text: 'x' } },
      {
        method: 'POST' as const,
        url: '/api/v1/ai/drafts/review-summary',
        body: { weekStart: '2026-10-05', scope: { includeTasks: true, includeExpenses: false } },
      },
      { method: 'POST' as const, url: '/api/v1/ai/drafts/d1/confirm', body: {} },
      { method: 'POST' as const, url: '/api/v1/ai/drafts/d1/cancel', body: {} },
      { method: 'GET' as const, url: '/api/v1/ai/usage' },
    ];

    for (const ep of endpoints) {
      const res = await fetch(ep.url, {
        method: ep.method,
        headers: { 'content-type': 'application/json' },
        // 无 body 时给 `null` 而不是 `undefined`：`RequestInit.body` 是
        // `BodyInit | null`，但 exactOptionalPropertyTypes 下显式传 `undefined` 不合法。
        body: ep.body ? JSON.stringify(ep.body) : null,
      });
      expect(res.status).toBeLessThan(400);
    }
  });

  it('点 4：expense-parse 生成失败仍 200 + status=failed + 空载荷', async () => {
    server.use(
      http.post('/api/v1/ai/drafts/expense-parse', () =>
        HttpResponse.json(
          envelope({
            draftId: 'd-fail',
            type: 'expense_parse',
            status: 'failed',
            draft: null,
            expiresAt: new Date().toISOString(),
          } as ExpenseParseDraftData),
        ),
      ),
    );

    const res = await fetch('/api/v1/ai/drafts/expense-parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '无金额' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('failed');
    expect(body.data.draft).toBeNull();
  });

  it('点 5：confirm pending → confirmed', async () => {
    server.use(
      http.post('/api/v1/ai/drafts/d1/confirm', () =>
        HttpResponse.json(
          envelope({
            draftId: 'd1',
            type: 'task_breakdown',
            status: 'confirmed',
            createdIds: [],
          } as AiDraftConfirmResult),
        ),
      ),
    );

    const res = await fetch('/api/v1/ai/drafts/d1/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('confirmed');
  });

  it('点 5：confirm failed → 422', async () => {
    server.use(
      http.post('/api/v1/ai/drafts/d-fail/confirm', () =>
        HttpResponse.json({ message: 'VALIDATION_ERROR', statusCode: 422 }, { status: 422 }),
      ),
    );

    const res = await fetch('/api/v1/ai/drafts/d-fail/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it('点 6：cancel pending → cancelled', async () => {
    server.use(
      http.post('/api/v1/ai/drafts/d1/cancel', () =>
        HttpResponse.json(
          envelope({
            draftId: 'd1',
            type: 'task_breakdown',
            status: 'cancelled',
          } as AiDraftStatusResult),
        ),
      ),
    );

    const res = await fetch('/api/v1/ai/drafts/d1/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('cancelled');
  });

  it('点 6：usage 月限触顶 429', async () => {
    server.use(
      http.get('/api/v1/ai/usage', () =>
        HttpResponse.json(
          {
            message: '本月 AI 调用次数已达上限',
            statusCode: 429,
            details: { limit: 100, used: 100 },
          },
          { status: 429 },
        ),
      ),
    );

    const res = await fetch('/api/v1/ai/usage');
    expect(res.status).toBe(429);
  });
});
