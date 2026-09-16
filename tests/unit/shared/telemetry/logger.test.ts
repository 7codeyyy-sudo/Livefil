/**
 * 结构化日志测试（FND-005）。
 *
 * 用内存 sink 收集记录，而不是捕获控制台输出：后者会与测试框架自身输出交织，
 * 且无法断言「记录对象」的精确形状。
 */
import { describe, expect, it } from 'vitest';

import type { LogRecord } from '@/shared/telemetry/log-record.ts';
import { createLogger, type LogSink } from '@/shared/telemetry/logger.ts';

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

/** 固定时钟，让时间戳可断言。 */
const FIXED_NOW = new Date('2026-09-16T04:00:00.000Z');
const fixedClock = (): Date => FIXED_NOW;

const APP_VERSION = '0.1.0';

describe('日志记录字段', () => {
  it('与《详细设计说明书》§9 的字段一致', () => {
    const { records, sink } = createRecordingSink();
    const logger = createLogger({ sink, now: fixedClock, appVersion: APP_VERSION });

    logger.error('操作失败', {
      requestId: 'req-1',
      anonymousUserId: 'anon-1',
      route: '/api/v1/tasks',
      operation: 'create_task',
      errorCode: 'VALIDATION_ERROR',
      durationMs: 120,
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      timestamp: '2026-09-16T04:00:00.000Z',
      level: 'error',
      channel: 'app',
      message: '操作失败',
      appVersion: APP_VERSION,
      requestId: 'req-1',
      anonymousUserId: 'anon-1',
      route: '/api/v1/tasks',
      operation: 'create_task',
      errorCode: 'VALIDATION_ERROR',
      durationMs: 120,
    });
  });

  it('未提供的可选字段不会出现在记录里', () => {
    const { records, sink } = createRecordingSink();
    const logger = createLogger({ sink, now: fixedClock, appVersion: APP_VERSION });

    logger.info('简单日志');

    // 「键不存在」与「键存在但为 undefined」对下游字段判断是两种含义。
    expect(Object.keys(records[0] ?? {}).sort()).toEqual([
      'appVersion',
      'channel',
      'level',
      'message',
      'timestamp',
    ]);
  });

  it('自定义上下文字段进入 context，不与保留字段混淆', () => {
    const { records, sink } = createRecordingSink();
    const logger = createLogger({ sink, now: fixedClock, appVersion: APP_VERSION });

    logger.info('自定义字段', { taskCount: 3, lifeAreaId: 'area-1' });

    expect(records[0]?.context).toEqual({ taskCount: 3, lifeAreaId: 'area-1' });
  });
});

describe('级别过滤', () => {
  it('低于阈值的级别不写出', () => {
    const { records, sink } = createRecordingSink();
    const logger = createLogger({ sink, level: 'warn', now: fixedClock });

    logger.debug('调试');
    logger.info('信息');
    logger.warn('警告');
    logger.error('错误');

    expect(records.map((record) => record.level)).toEqual(['warn', 'error']);
  });

  it('缺省阈值为 info', () => {
    const { records, sink } = createRecordingSink();
    const logger = createLogger({ sink, now: fixedClock });

    logger.debug('调试');
    logger.info('信息');

    expect(records.map((record) => record.level)).toEqual(['info']);
  });
});

describe('脱敏在写入前生效', () => {
  it('敏感字段原文不出现在输出中', () => {
    const { records, sink } = createRecordingSink();
    const logger = createLogger({ sink, now: fixedClock });

    logger.info('创建任务', {
      requestId: 'req-1',
      password: 'hunter2',
      accessToken: 'eyJhbGciOiJIUzI1NiJ9',
    });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    // 非敏感字段保留，日志仍可用于排查。
    expect(records[0]?.requestId).toBe('req-1');
  });

  it('超长文本被截断', () => {
    const { records, sink } = createRecordingSink();
    const logger = createLogger({ sink, now: fixedClock });
    const longTitle = 'x'.repeat(500);

    logger.info('记录任务标题', { taskTitle: longTitle });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(longTitle);
    expect(serialized).toContain('[TRUNCATED');
  });

  it('日志消息本身也被截断', () => {
    const { records, sink } = createRecordingSink();
    const logger = createLogger({ sink, now: fixedClock });

    logger.info('y'.repeat(500));

    expect(records[0]?.message).toContain('[TRUNCATED');
  });
});

describe('child logger', () => {
  it('绑定的字段出现在每条记录中', () => {
    const { records, sink } = createRecordingSink();
    const logger = createLogger({ sink, now: fixedClock, appVersion: APP_VERSION });
    const requestLogger = logger.child({ requestId: 'req-9', route: '/api/v1/tasks' });

    requestLogger.info('第一条');
    requestLogger.info('第二条');

    expect(records.map((record) => record.requestId)).toEqual(['req-9', 'req-9']);
    expect(records.map((record) => record.route)).toEqual(['/api/v1/tasks', '/api/v1/tasks']);
  });

  it('调用点传入的字段覆盖绑定值', () => {
    const { records, sink } = createRecordingSink();
    const logger = createLogger({ sink, now: fixedClock });
    const requestLogger = logger.child({ requestId: 'req-9' });

    requestLogger.info('覆盖', { requestId: 'req-10' });

    expect(records[0]?.requestId).toBe('req-10');
  });

  it('child 不影响父 logger', () => {
    const { records, sink } = createRecordingSink();
    const logger = createLogger({ sink, now: fixedClock });

    logger.child({ requestId: 'req-9' });
    logger.info('父级');

    expect(records[0]?.requestId).toBeUndefined();
  });
});

describe('不可变性', () => {
  it('写入的记录被冻结', () => {
    const { records, sink } = createRecordingSink();
    const logger = createLogger({ sink, now: fixedClock });

    logger.info('x');

    expect(Object.isFrozen(records[0])).toBe(true);
  });
});
