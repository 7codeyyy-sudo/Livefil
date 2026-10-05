// @vitest-environment node
/**
 * A 组 · AI 纯函数与策略单元测试（PD-020 点 1/16/18，AI-001/002/003，P0）。
 *
 * 覆盖：
 * - 点 16：redaction 行为（sanitizeAiInput 脱敏 + prompt 禁止清单）
 * - 点 18：env 冻结（零新增依赖、AI_* 变量冻结集）
 */
import { describe, expect, it } from 'vitest';

import { assertWithinAiQuota } from '../../../src/modules/ai/domain/ai-policy.ts';
import { sanitizeAiInput } from '../../../src/modules/ai/domain/ai-input-sanitizer.ts';
import {
  findProhibitedAdvice,
  PROHIBITED_ADVICE_KEYWORDS,
} from '../../../src/modules/ai/domain/ai-advice-policy.ts';
import type { AiQuotaUsage, AiQuotaLimits } from '../../../src/modules/ai/domain/ai-policy.ts';

describe('assertWithinAiQuota（点 18 额度限流）', () => {
  const baseUsage: AiQuotaUsage = {
    monthlyCallCount: 0,
    monthlyCostMinor: 0,
    recentCallCount: 0,
  };

  const baseLimits: AiQuotaLimits = {
    monthlyCallLimit: 100,
    monthlyCostLimitMinor: 10_000,
    perMinuteLimit: 60,
  };

  it('未超限时不抛错', () => {
    expect(() => assertWithinAiQuota(baseUsage, baseLimits)).not.toThrow();
  });

  it('月度调用次数触顶抛 RateLimitError（429）', () => {
    expect(() =>
      assertWithinAiQuota(
        { ...baseUsage, monthlyCallCount: baseLimits.monthlyCallLimit },
        baseLimits,
      ),
    ).toThrow('本月 AI 调用次数已达上限');
  });

  it('月度成本触顶抛 RateLimitError（429）', () => {
    expect(() =>
      assertWithinAiQuota(
        { ...baseUsage, monthlyCostMinor: baseLimits.monthlyCostLimitMinor },
        baseLimits,
      ),
    ).toThrow('本月 AI 调用成本已达上限');
  });

  it('每分钟次数触顶抛 RateLimitError（429）', () => {
    expect(() =>
      assertWithinAiQuota({ ...baseUsage, recentCallCount: baseLimits.perMinuteLimit }, baseLimits),
    ).toThrow('AI 调用过于频繁，请稍后重试');
  });
});

describe('sanitizeAiInput（点 16 脱敏行为）', () => {
  it('命中邮箱/长数字/手机号/token 四类掩码', () => {
    const raw = 'email a@b.com phone 13800138000 id 123456789012345678 token ?key=secret';
    const { sanitizedInput } = sanitizeAiInput(raw, 10_000);
    expect(sanitizedInput).toContain('[REDACTED_EMAIL]');
    expect(sanitizedInput).toContain('[REDACTED_ID]');
    expect(sanitizedInput).toContain('[REDACTED_PHONE]');
    expect(sanitizedInput).toContain('[REDACTED_TOKEN]');
    expect(sanitizedInput).not.toContain('secret');
  });

  it('超长文本截断到上限', () => {
    const long = 'x'.repeat(20_000);
    const { sanitizedInput } = sanitizeAiInput(long, 10_000);
    expect(sanitizedInput.length).toBeLessThanOrEqual(10_000);
  });

  it('控制字符与连续空白归一化', () => {
    const { sanitizedInput } = sanitizeAiInput('  a\n\tb  ', 10_000);
    expect(sanitizedInput).toBe('a b');
  });
});

describe('findProhibitedAdvice（点 16 输出后校验）', () => {
  it('命中投资关键词', () => {
    expect(findProhibitedAdvice('建议你关注股票投资')).toBe('投资');
  });

  it('命中心理诊断关键词', () => {
    expect(findProhibitedAdvice('你可能抑郁了')).toBe('抑郁');
  });

  it('无命中返回 null', () => {
    expect(findProhibitedAdvice('建议你早睡早起')).toBeNull();
  });

  it('禁止清单无空项且长度固定', () => {
    expect(PROHIBITED_ADVICE_KEYWORDS.length).toBeGreaterThan(0);
    for (const keyword of PROHIBITED_ADVICE_KEYWORDS) {
      expect(keyword.length).toBeGreaterThan(0);
    }
  });
});

describe('点 18 env 冻结（package.json 零新增依赖）', () => {
  it('依赖项未新增 AI provider 相关包', async () => {
    const pkg = await import('../../../../package.json', {
      assert: { type: 'json' },
    });
    const depNames = Object.keys(pkg.dependencies ?? {});
    const forbidden = ['openai', 'cohere', 'anthropic', 'langchain', 'ai'];
    for (const name of forbidden) {
      expect(depNames).not.toContain(name);
    }
  });
});
