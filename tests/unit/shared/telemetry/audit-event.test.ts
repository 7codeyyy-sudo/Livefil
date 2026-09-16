/**
 * 审计事件测试（FND-005）。
 *
 * 两条主线：
 * 1. **覆盖度**：SRS §6.7 列出的每一类事件都有对应的类型，且都能归类。
 * 2. **通道正确**：审计记录必须落在 `audit` 通道——留存策略（90 天 vs 30 天）
 *    完全依赖这个标记，标错了不会立刻显现，只会在做合规清理时暴露。
 */
import { describe, expect, it } from 'vitest';

import type { LogRecord } from '@/shared/telemetry/log-record.ts';
import { createAuditLogger } from '@/shared/telemetry/audit-event.ts';
import type { AuditEventType } from '@/shared/telemetry/audit-event.ts';
import type { LogSink } from '@/shared/telemetry/logger.ts';

/** 收集写入记录的内存 sink。 */
function createRecordingSink(): { readonly records: LogRecord[]; readonly sink: LogSink } {
  const records: LogRecord[] = [];
  return {
    records,
    sink: Object.freeze({
      write: (record: LogRecord): void => {
        records.push(record);
      },
    }),
  };
}

const FIXED_NOW = new Date('2026-09-16T04:00:00.000Z');
const fixedClock = (): Date => FIXED_NOW;

const APP_VERSION = '0.1.0';

/** SRS §6.7 的 6 类事件各自应当覆盖的类型。 */
const EXPECTED_TYPES_BY_CATEGORY = {
  authentication: ['AUTH_LOGIN_SUCCEEDED', 'AUTH_LOGIN_FAILED'],
  'data-mutation': ['DATA_CREATED', 'DATA_UPDATED', 'DATA_DELETED', 'DATA_RESTORED'],
  'data-portability': ['DATA_EXPORTED', 'DATA_IMPORTED'],
  'ai-invocation': [
    'AI_INVOCATION_STARTED',
    'AI_INVOCATION_SUCCEEDED',
    'AI_INVOCATION_FAILED',
    'AI_INVOCATION_TIMED_OUT',
    'AI_QUOTA_EXHAUSTED',
  ],
  'access-control': ['PERMISSION_DENIED', 'ABNORMAL_REQUEST'],
  sync: ['SYNC_CONFLICT_DETECTED'],
} as const;

describe('事件类目覆盖 SRS §6.7', () => {
  it('6 类共 16 个事件类型全部可归类', () => {
    const totalTypes = Object.values(EXPECTED_TYPES_BY_CATEGORY).flat();

    expect(totalTypes).toHaveLength(16);
    // 去重后长度不变，说明没有把同一个类型登记到两个类目下。
    expect(new Set(totalTypes).size).toBe(16);
  });

  it('每个事件都写出正确的 category', () => {
    for (const [category, types] of Object.entries(EXPECTED_TYPES_BY_CATEGORY)) {
      for (const type of types) {
        const { records, sink } = createRecordingSink();
        const auditLogger = createAuditLogger({
          appVersion: APP_VERSION,
          sink,
          now: fixedClock,
        });

        auditLogger.record({
          type: type as AuditEventType,
          outcome: 'succeeded',
          anonymousUserId: 'anon-1',
        });

        const auditEvent = (records[0]?.context as { auditEvent?: { category?: string } })
          ?.auditEvent;

        expect(auditEvent?.category, `${type} 的类目应为 ${category}`).toBe(category);
      }
    }
  });
});

describe('审计记录形态', () => {
  it('包含 SRS 要求的四项：时间、结果、匿名用户标识、版本', () => {
    const { records, sink } = createRecordingSink();
    const auditLogger = createAuditLogger({ appVersion: APP_VERSION, sink, now: fixedClock });

    auditLogger.record({
      type: 'AUTH_LOGIN_SUCCEEDED',
      outcome: 'succeeded',
      anonymousUserId: 'anon-42',
      requestId: 'req-7',
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.context).toEqual({
      auditEvent: {
        type: 'AUTH_LOGIN_SUCCEEDED',
        category: 'authentication',
        outcome: 'succeeded',
        occurredAt: '2026-09-16T04:00:00.000Z',
        anonymousUserId: 'anon-42',
        appVersion: APP_VERSION,
        requestId: 'req-7',
      },
    });
  });

  it('落在 audit 通道，与运行日志可区分', () => {
    const { records, sink } = createRecordingSink();
    const auditLogger = createAuditLogger({ appVersion: APP_VERSION, sink, now: fixedClock });

    auditLogger.record({
      type: 'SYNC_CONFLICT_DETECTED',
      outcome: 'failed',
      anonymousUserId: null,
    });

    expect(records[0]?.channel).toBe('audit');
  });

  it('失败事件可携带错误码', () => {
    const { records, sink } = createRecordingSink();
    const auditLogger = createAuditLogger({ appVersion: APP_VERSION, sink, now: fixedClock });

    auditLogger.record({
      type: 'AUTH_LOGIN_FAILED',
      outcome: 'failed',
      anonymousUserId: null,
      errorCode: 'AUTHENTICATION_REQUIRED',
    });

    const auditEvent = (records[0]?.context as { auditEvent?: Record<string, unknown> })
      ?.auditEvent;

    expect(auditEvent?.['outcome']).toBe('failed');
    expect(auditEvent?.['errorCode']).toBe('AUTHENTICATION_REQUIRED');
    // 登录失败时还没有用户身份，这里必须是 null 而不是空字符串。
    expect(auditEvent?.['anonymousUserId']).toBeNull();
  });

  it('未提供的可选字段不出现在事件里', () => {
    const { records, sink } = createRecordingSink();
    const auditLogger = createAuditLogger({ appVersion: APP_VERSION, sink, now: fixedClock });

    auditLogger.record({
      type: 'DATA_DELETED',
      outcome: 'succeeded',
      anonymousUserId: 'anon-1',
    });

    const auditEvent = (records[0]?.context as { auditEvent?: Record<string, unknown> })
      ?.auditEvent;

    expect(Object.keys(auditEvent ?? {}).sort()).toEqual([
      'anonymousUserId',
      'appVersion',
      'category',
      'occurredAt',
      'outcome',
      'type',
    ]);
  });
});

describe('审计事件同样受脱敏约束', () => {
  it('事件内的字段若命中禁止清单也会被替换', () => {
    const { records, sink } = createRecordingSink();
    const auditLogger = createAuditLogger({ appVersion: APP_VERSION, sink, now: fixedClock });

    // 用类型断言构造一个「不该存在」的输入，验证它不会绕过脱敏。
    auditLogger.record({
      type: 'ABNORMAL_REQUEST',
      outcome: 'failed',
      anonymousUserId: 'anon-1',
      ...({ sessionToken: 'secret-token-value' } as object),
    });

    expect(JSON.stringify(records)).not.toContain('secret-token-value');
  });
});

describe('级别过滤对审计事件同样生效', () => {
  it('阈值高于 info 时审计事件不会被写出（调用方需知悉）', () => {
    const { records, sink } = createRecordingSink();
    const auditLogger = createAuditLogger({
      appVersion: APP_VERSION,
      sink,
      level: 'error',
      now: fixedClock,
    });

    auditLogger.record({
      type: 'DATA_EXPORTED',
      outcome: 'succeeded',
      anonymousUserId: 'anon-1',
    });

    // 记录当前行为：审计事件以 info 写出，因此会受阈值过滤。
    // 若将来要求审计必须无条件记录，应改的是实现而不是这条断言。
    expect(records).toHaveLength(0);
  });
});
