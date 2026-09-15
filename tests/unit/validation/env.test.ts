/**
 * 服务端环境变量校验的单元测试（FND-001）。
 *
 * 覆盖：正常路径、空数据、非法输入、条件必填、边界值，以及
 * 「错误信息不得回显变量取值」这一安全约束。
 *
 * 用 Node 内置测试运行器（零依赖），不预先替 FND-003 做测试框架选型。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EnvValidationError,
  LOG_LEVELS,
  MOCK_AI_PROVIDER,
  parseServerEnv,
} from '../../../src/shared/validation/env.ts';

const VALID_DATABASE_URL = 'postgresql://livefil:secret@127.0.0.1:5432/livefil_dev';
const VALID_AUTH_SECRET = 'a'.repeat(32);

/** 断言调用抛出 EnvValidationError，并返回其问题列表以便进一步断言。 */
function captureIssues(source: Record<string, string | undefined>): readonly string[] {
  try {
    parseServerEnv(source);
  } catch (error) {
    assert.ok(error instanceof EnvValidationError, `期望 EnvValidationError，实际为 ${String(error)}`);
    return error.issues;
  }
  assert.fail('期望抛出 EnvValidationError，但校验通过了');
}

describe('parseServerEnv 正常路径', () => {
  it('完整合法配置被正确解析', () => {
    const env = parseServerEnv({
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      DATABASE_URL: VALID_DATABASE_URL,
      AUTH_SECRET: VALID_AUTH_SECRET,
      AI_PROVIDER: 'openai',
      AI_API_KEY: 'test-key',
    });

    assert.equal(env.nodeEnv, 'production');
    assert.equal(env.logLevel, 'warn');
    assert.equal(env.databaseUrl, VALID_DATABASE_URL);
    assert.equal(env.authSecret, VALID_AUTH_SECRET);
    assert.equal(env.aiProvider, 'openai');
    assert.equal(env.aiApiKey, 'test-key');
  });

  it('归一化时去除首尾空白', () => {
    const env = parseServerEnv({ LOG_LEVEL: '  debug  ', AI_PROVIDER: ` ${MOCK_AI_PROVIDER} ` });

    assert.equal(env.logLevel, 'debug');
    assert.equal(env.aiProvider, MOCK_AI_PROVIDER);
  });

  it('返回值为只读对象，避免运行期被意外改写', () => {
    const env = parseServerEnv({});

    assert.ok(Object.isFrozen(env));
  });
});

describe('parseServerEnv 空数据', () => {
  it('空环境变量返回安全默认值', () => {
    const env = parseServerEnv({});

    assert.equal(env.nodeEnv, 'development');
    assert.equal(env.logLevel, 'info');
    assert.equal(env.aiProvider, MOCK_AI_PROVIDER);
    assert.equal(env.databaseUrl, undefined);
    assert.equal(env.authSecret, undefined);
    assert.equal(env.aiApiKey, undefined);
  });

  it('不因存在无关变量而失败', () => {
    // 取值刻意不用真实路径形态，避免路径门禁把它们误判成硬编码绝对路径。
    const env = parseServerEnv({ PATH: 'bin-dir-1:bin-dir-2', HOME: 'user-home-dir', RANDOM_FLAG: '1' });

    assert.equal(env.logLevel, 'info');
  });

  it('mock 供应商不要求配置密钥', () => {
    const env = parseServerEnv({ AI_PROVIDER: MOCK_AI_PROVIDER });

    assert.equal(env.aiApiKey, undefined);
  });
});

describe('parseServerEnv 非法输入', () => {
  it('LOG_LEVEL 取值不在枚举内时报错', () => {
    const issues = captureIssues({ LOG_LEVEL: 'verbose' });

    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? '', /^LOG_LEVEL: /);
    assert.match(issues[0] ?? '', /debug \| info \| warn \| error/);
  });

  it('LOG_LEVEL 大小写敏感，不接受大写', () => {
    const issues = captureIssues({ LOG_LEVEL: 'DEBUG' });

    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? '', /^LOG_LEVEL: /);
  });

  it('LOG_LEVEL 为空字符串时报错', () => {
    const issues = captureIssues({ LOG_LEVEL: '   ' });

    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? '', /^LOG_LEVEL: /);
    assert.match(issues[0] ?? '', /debug \| info \| warn \| error/);
  });

  it('DATABASE_URL 为空字符串时报错', () => {
    const issues = captureIssues({ DATABASE_URL: '' });

    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? '', /^DATABASE_URL: /);
  });

  it('AUTH_SECRET 为空字符串时报错', () => {
    const issues = captureIssues({ AUTH_SECRET: '' });

    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? '', /^AUTH_SECRET: /);
  });

  it('NODE_ENV 为空字符串时报错', () => {
    const issues = captureIssues({ NODE_ENV: ' ' });

    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? '', /^NODE_ENV: /);
  });

  it('AI_PROVIDER 为空字符串时报错', () => {
    const issues = captureIssues({ AI_PROVIDER: '  ' });

    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? '', /^AI_PROVIDER: /);
  });

  it('同一个变量的非法输入只产生一条错误', () => {
    // 回归测试：曾出现「非空」与「变量专属规则」各报一次、同一变量重复报错的问题。
    const cases: Record<string, string>[] = [
      { NODE_ENV: '' },
      { LOG_LEVEL: '' },
      { LOG_LEVEL: 'verbose' },
      { DATABASE_URL: '' },
      { DATABASE_URL: 'not-a-url' },
      { AUTH_SECRET: '' },
      { AUTH_SECRET: 'too-short' },
      { AI_PROVIDER: '' },
      { AI_API_KEY: '' },
    ];

    for (const source of cases) {
      const variableName = Object.keys(source)[0] ?? '';
      const issues = captureIssues(source);

      assert.equal(
        issues.length,
        1,
        `${variableName} 应只产生一条错误，实际 ${issues.length} 条：${issues.join(' / ')}`,
      );
    }
  });

  it('DATABASE_URL 不是合法 URL 时报错', () => {
    const issues = captureIssues({ DATABASE_URL: 'not-a-url' });

    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? '', /^DATABASE_URL: /);
  });

  it('DATABASE_URL 协议不受支持时报错', () => {
    const issues = captureIssues({ DATABASE_URL: 'mysql://user:pass@127.0.0.1:3306/db' });

    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? '', /^DATABASE_URL: /);
  });

  it('AUTH_SECRET 过短时报错', () => {
    const issues = captureIssues({ AUTH_SECRET: 'too-short' });

    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? '', /^AUTH_SECRET: /);
  });

  it('AI_PROVIDER 非 mock 但缺少 AI_API_KEY 时报条件必填错误', () => {
    const issues = captureIssues({ AI_PROVIDER: 'openai' });

    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? '', /AI_API_KEY/);
    assert.match(issues[0] ?? '', /必须配置/);
  });

  it('多项同时非法时一次性列出全部问题', () => {
    const issues = captureIssues({
      LOG_LEVEL: 'verbose',
      DATABASE_URL: 'not-a-url',
      AUTH_SECRET: 'short',
      AI_PROVIDER: 'openai',
    });

    assert.equal(issues.length, 4);
  });
});

describe('parseServerEnv 错误信息不回显变量取值', () => {
  const secretLikeValue = 'super-secret-value-should-not-be-logged';

  it('非法取值不出现在异常信息中', () => {
    try {
      parseServerEnv({ DATABASE_URL: secretLikeValue, LOG_LEVEL: secretLikeValue });
      assert.fail('期望抛出 EnvValidationError，但校验通过了');
    } catch (error) {
      assert.ok(error instanceof EnvValidationError);
      assert.ok(!error.message.includes(secretLikeValue), '异常信息中不应包含环境变量取值');
      assert.ok(!error.issues.join(' ').includes(secretLikeValue), '问题列表不应包含环境变量取值');
    }
  });

  it('过短的密钥取值不出现在异常信息中', () => {
    const shortSecret = 'abc123';

    const issues = captureIssues({ AUTH_SECRET: shortSecret });

    assert.ok(!issues.join(' ').includes(shortSecret));
  });
});

describe('parseServerEnv 边界条件', () => {
  it('AUTH_SECRET 恰好达到最小长度时通过', () => {
    const env = parseServerEnv({ AUTH_SECRET: 'b'.repeat(32) });

    assert.equal(env.authSecret, 'b'.repeat(32));
  });

  it('AUTH_SECRET 比最小长度少一个字符时失败', () => {
    const issues = captureIssues({ AUTH_SECRET: 'b'.repeat(31) });

    assert.equal(issues.length, 1);
  });

  it('LOG_LEVELS 的每个取值都被接受', () => {
    for (const level of LOG_LEVELS) {
      const env = parseServerEnv({ LOG_LEVEL: level });

      assert.equal(env.logLevel, level);
    }
  });

  it('值为非字符串（undefined）时按未设置处理', () => {
    const env = parseServerEnv({ LOG_LEVEL: undefined, AI_PROVIDER: undefined });

    assert.equal(env.logLevel, 'info');
    assert.equal(env.aiProvider, MOCK_AI_PROVIDER);
  });
});
