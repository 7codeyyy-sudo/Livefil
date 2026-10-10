/**
 * 登出（AUTH-002，《接口文档》v0.8 #4；RD-012 §3 流 5）。
 *
 * 吊销**当前**会话行（`revokedAt` 即时生效——行状态是权威，令牌里的 `exp`
 * 只做前置快拒）+ 清除 Cookie。幂等：重复登出仍 200。
 */
import type { AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';

import type { SessionRepository } from '../domain/session.ts';

export interface LogoutDependencies {
  readonly sessions: SessionRepository;
  readonly audit: AuditLogger;
  readonly now?: (() => number) | undefined;
}

export class LogoutUseCase {
  readonly #sessions: SessionRepository;
  readonly #audit: AuditLogger;
  readonly #now: () => number;

  constructor(dependencies: LogoutDependencies) {
    this.#sessions = dependencies.sessions;
    this.#audit = dependencies.audit;
    this.#now = dependencies.now ?? Date.now;
  }

  /** 吊销当前会话（幂等）。 */
  async execute(userId: string, sessionId: string): Promise<void> {
    await this.#sessions.revoke(sessionId, userId, new Date(this.#now()));
    this.#audit.record({
      type: 'AUTH_LOGOUT_SUCCEEDED',
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
    });
  }
}
