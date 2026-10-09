/**
 * 认证会话的签发（AUTH-002，RD-012 §3 流 1/2/3；《数据库设计文档》§4.19）。
 *
 * 注册与登录共用的「建行 + 签令牌」两步。**不复用入站会话**是会话固定防护的
 * 本体：每次成功认证都新建行、签发新令牌——攻击者预置的 sid 永远轮不到
 * 被「升格」为已认证会话（RD-012 §3 流 2 步 3）。
 *
 * 设备标签只做**卫生处理**（截断 + 去控制字符）：它是账号设置/审计的可读线索，
 * 不是设备指纹——为此引入 UA 解析库违反零依赖纪律（RD-012 §8.1）。
 */
import type { SessionTokenService } from '../domain/session-token.ts';
import type { SessionRepository } from '../domain/session.ts';
import { SESSION_TTL_DAYS, type CloudSessionPayload } from '../domain/session.ts';

export interface IssueSessionInput {
  readonly userId: string;
  /** 原始 User-Agent（可空）；实现内截断与清洗。 */
  readonly userAgent: string | null;
}

export interface IssuedSession {
  /** 可直接写入 Cookie 的令牌。 */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface IssueSessionDependencies {
  readonly sessions: SessionRepository;
  readonly signer: SessionTokenService;
  readonly now?: (() => number) | undefined;
}

/**
 * 清洗设备标签：剥离 C0/C1 控制字符、trim、截到 120（列长），空串归 null。
 *
 * 用码点过滤而不是正则字符类：控制字符的字面区间写进源文件会产生不可见
 * 字节，跨平台检出与 diff 审查都无法可靠呈现。
 */
export function sanitizeDeviceLabel(userAgent: string | null): string | null {
  if (userAgent === null) {
    return null;
  }
  let cleaned = '';
  for (const char of userAgent) {
    const code = char.codePointAt(0) ?? 0;
    // C0（0x00-0x1F）、DEL（0x7F）、C1（0x80-0x9F）。
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }
    cleaned += char;
  }
  cleaned = cleaned.trim();
  if (cleaned === '') {
    return null;
  }
  return cleaned.slice(0, 120);
}

/**
 * 新建会话行并签发令牌。
 *
 * 每次调用都新建行（会话固定防护——入站 sid 永不复用）并顺手做惰性清理
 * （删本人过期/吊销行，RD-012 §2.2：不引入 cron）。
 */
export async function issueSession(
  dependencies: IssueSessionDependencies,
  input: IssueSessionInput,
): Promise<IssuedSession> {
  const nowMs = (dependencies.now ?? Date.now)();
  const now = new Date(nowMs);
  const expiresAt = new Date(nowMs + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await dependencies.sessions.purgeExpired(input.userId, now);

  const session = await dependencies.sessions.create({
    userId: input.userId,
    deviceLabel: sanitizeDeviceLabel(input.userAgent),
    expiresAt,
  });

  const payload: CloudSessionPayload = {
    userId: input.userId,
    sessionId: session.id,
    issuedAt: nowMs,
    exp: expiresAt.getTime(),
  };

  return { token: dependencies.signer.sign(payload), expiresAt };
}
