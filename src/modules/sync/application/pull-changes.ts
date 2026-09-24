/**
 * 增量拉取的用例（SYNC-001，《接口文档》§12.1.2）。
 *
 * 用例只做三件事：解游标、算安全滞后上界、把游标交给仓储并把结果透传出去。
 * "哪些行算变更、按什么顺序排"属于持久化细节（`sync-repository.ts` 的端口语义），
 * 放在这里会让领域规则与表结构耦合。
 */
import { ValidationError } from '@/shared/errors/app-error.ts';

import { decodePullCursor, type SyncChange } from '../domain/sync-change.ts';
import type { SyncRepository } from '../domain/sync-repository.ts';

export interface PullChangesDependencies {
  readonly sync: SyncRepository;
  /** 安全滞后窗口（毫秒）。只返回提交满该时长的变更（§12.1.2 的漏读防护）。 */
  readonly lagMs: number;
  /** 当前时间，可注入以便测试固定时钟。 */
  readonly now?: () => Date;
}

export interface PullChangesInput {
  /** 不透明游标；首次拉取不传。 */
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface PullChangesResult {
  readonly changes: readonly SyncChange[];
  readonly nextCursor: string | null;
}

export class PullChangesUseCase {
  readonly #sync: SyncRepository;
  readonly #lagMs: number;
  readonly #now: () => Date;

  constructor(dependencies: PullChangesDependencies) {
    this.#sync = dependencies.sync;
    this.#lagMs = dependencies.lagMs;
    this.#now = dependencies.now ?? ((): Date => new Date());
  }

  async execute(userId: string, input: PullChangesInput): Promise<PullChangesResult> {
    const after = input.cursor === undefined ? null : decodePullCursor(input.cursor);
    if (input.cursor !== undefined && after === null) {
      // 游标解不开就是客户端的输入问题（常见于把别的分页端点的游标贴过来），
      // 报 400 并让客户端从空游标重新开始，而不是悄悄当成"从头拉"——那会重复拉一大片。
      throw new ValidationError('cursor 不是合法的同步游标');
    }

    const until = new Date(this.#now().getTime() - this.#lagMs);
    const page = await this.#sync.listChanges(userId, {
      after,
      until,
      limit: input.limit,
    });

    return { changes: page.changes, nextCursor: page.nextCursor };
  }
}
