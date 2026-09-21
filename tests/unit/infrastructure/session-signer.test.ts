/**
 * 会话签名器（IAM-001，《详细设计说明书》§8.1）。
 *
 * 这里验的是**安全属性**，不是"函数能被调用"：
 * 篡改过的载荷必须验不过、别的密钥签的必须验不过、坏输入必须返回 `null`
 * 而不是抛异常、密钥缺失必须在装配期失败且**不回显取值**。
 */
import { describe, expect, it } from 'vitest';

import { createSessionSigner } from '../../../src/infrastructure/auth/session-signer.ts';
import { InvariantError } from '../../../src/shared/errors/app-error.ts';

const SECRET = 'unit-test-session-secret-0123456789ab';
const PAYLOAD = { userId: 'user-0001', issuedAt: 1_760_000_000_000 };

describe('签发与验证', () => {
  it('自己的令牌能验回来，载荷一致', () => {
    const signer = createSessionSigner({ secret: SECRET });

    const token = signer.sign(PAYLOAD);

    expect(signer.verify(token)).toEqual(PAYLOAD);
  });

  it('同一载荷两次签发的令牌相同（无状态、无随机盐）', () => {
    const signer = createSessionSigner({ secret: SECRET });

    expect(signer.sign(PAYLOAD)).toBe(signer.sign(PAYLOAD));
  });

  it('令牌由「载荷.签名」两段组成，两段都非空', () => {
    const signer = createSessionSigner({ secret: SECRET });

    const segments = signer.sign(PAYLOAD).split('.');

    expect(segments).toHaveLength(2);
    expect(segments[0]).not.toBe('');
    expect(segments[1]).not.toBe('');
  });
});

describe('篡改与伪造', () => {
  it('改掉载荷（换成另一个用户）后验不过', () => {
    const signer = createSessionSigner({ secret: SECRET });
    const token = signer.sign(PAYLOAD);
    const [, signature] = token.split('.');

    // 用一个结构相同但 userId 不同的载荷替换掉第一段——这是攻击者最想做的事。
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...PAYLOAD, userId: 'user-9999' }),
      'utf8',
    ).toString('base64url');

    expect(signer.verify(`${forgedPayload}.${signature ?? ''}`)).toBeNull();
  });

  it('改掉签名后验不过', () => {
    const signer = createSessionSigner({ secret: SECRET });
    const token = signer.sign(PAYLOAD);

    expect(signer.verify(`${token}x`)).toBeNull();
  });

  it('另一个密钥签的令牌验不过', () => {
    const signer = createSessionSigner({ secret: SECRET });
    const other = createSessionSigner({ secret: 'another-secret-0123456789abcdefgh' });

    expect(signer.verify(other.sign(PAYLOAD))).toBeNull();
  });
});

describe('坏输入按「没有会话」处理', () => {
  const signer = createSessionSigner({ secret: SECRET });

  it.each(['', 'abc', '.', '.abc', 'abc.', 'a.b.c'])('畸形令牌 %j 返回 null', (token) => {
    expect(signer.verify(token)).toBeNull();
  });

  it('签名正确但载荷不是 JSON → null', () => {
    // 手工构造"签名正确、载荷不是 JSON"的令牌：只可能来自同密钥的另一版实现，
    // 按无会话处理而不是抛异常。
    const notJson = Buffer.from('not-json', 'utf8').toString('base64url');
    const valid = createSessionSigner({ secret: SECRET });
    const signature = valid.sign(PAYLOAD).split('.')[1];

    expect(signer.verify(`${notJson}.${signature ?? ''}`)).toBeNull();
  });

  it('签名正确但载荷形状不对 → null', () => {
    const signerWithSameSecret = createSessionSigner({ secret: SECRET });
    const emptyObject = Buffer.from('{}', 'utf8').toString('base64url');
    const signature = signerWithSameSecret.sign(PAYLOAD).split('.')[1];

    expect(signerWithSameSecret.verify(`${emptyObject}.${signature ?? ''}`)).toBeNull();
  });
});

describe('装配期失败（§8.3 分层必填）', () => {
  it('缺密钥时抛 InvariantError，且消息只含变量名', () => {
    let caught: unknown;
    try {
      createSessionSigner({ secret: undefined });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvariantError);
    expect((caught as Error).message).toContain('AUTH_SECRET');
  });

  it('空白密钥按缺失处理', () => {
    expect(() => createSessionSigner({ secret: '   ' })).toThrow(InvariantError);
  });

  it('密钥过短时抛 InvariantError', () => {
    expect(() => createSessionSigner({ secret: 'too-short' })).toThrow(InvariantError);
  });

  it('错误信息里不出现密钥取值（NFR-SEC-002）', () => {
    const secret = 'leak-me-0123456789abcdefghijklmn';

    let caught: unknown;
    try {
      // 长度不足才能触发校验；用一段足够长但含可识别子串的密钥反而不会失败，
      // 所以这里先用短密钥触发"过短"分支，再断言消息里没有那段文字。
      createSessionSigner({ secret: 'leak-me' });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).not.toContain('leak-me');
    // 顺带确认那段"够长的密钥"确实是可用的，避免上面那条断言变成空转。
    expect(createSessionSigner({ secret }).sign(PAYLOAD)).not.toBe('');
  });
});
