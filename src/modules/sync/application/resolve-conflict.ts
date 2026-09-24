/**
 * 解决冲突的用例（SYNC-004，《接口文档》§12、§12.1.3）。
 *
 * ## 交付范围
 *
 * P0 只交付 `keep_server` / `keep_local`：`manual_merge` 保留取值与端点语义，
 * 但本批**不提供 UI、也不接受**——真收到就返回 400，而不是假装成功或落到
 * "按 keep_server 处理"这种会让用户以为合并生效的默认行为上（§12.1.3）。
 *
 * ## 两个失败语义
 *
 * - 404：冲突不存在，或不属于当前用户（两种情形共用 404 是刻意的：403 会泄露
 *   "该冲突存在"这一信息，与 `NotFoundError` 的既定口径一致）。
 * - 409：已经解决过（含并发解决）。重复解决不是幂等操作——用户点了两次"以本地为准"
 *   而第二次悄悄成功，会掩盖第一次是否真的写进去了。
 */
import { ConflictError, NotFoundError, ValidationError } from '@/shared/errors/app-error.ts';

import type {
  ConflictResolution,
  SyncConflict,
  SyncConflictRepository,
} from '../domain/sync-conflict.ts';
import type { ConflictService } from './conflict-service.ts';

export interface ResolveConflictDependencies {
  readonly conflicts: SyncConflictRepository;
  readonly conflictService: ConflictService;
}

export class ResolveConflictUseCase {
  readonly #conflicts: SyncConflictRepository;
  readonly #conflictService: ConflictService;

  constructor(dependencies: ResolveConflictDependencies) {
    this.#conflicts = dependencies.conflicts;
    this.#conflictService = dependencies.conflictService;
  }

  async execute(
    userId: string,
    conflictId: string,
    resolution: ConflictResolution,
  ): Promise<SyncConflict> {
    if (resolution === 'manual_merge') {
      throw new ValidationError('manual_merge 顺延，本批不支持（接口文档 §12.1.3）');
    }

    const conflict = await this.#conflicts.findById(userId, conflictId);
    if (conflict === null) {
      throw new NotFoundError('同步冲突不存在');
    }
    if (conflict.status !== 'pending') {
      throw new ConflictError('该冲突已经处理过');
    }

    // `keep_server` 不需要写实体：服务端本来就是权威版本，只需把记录标记为已解决。
    if (resolution === 'keep_local') {
      await this.#conflictService.keepLocal(userId, conflict);
    }

    const resolved = await this.#conflicts.markResolved(userId, conflictId);
    if (resolved === null) {
      // 读与写之间被另一个请求抢先解决：以 409 收场，让客户端刷新后看到真实状态。
      throw new ConflictError('该冲突已被其他请求处理');
    }
    return resolved;
  }
}
