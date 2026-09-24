/**
 * 冲突的领域服务（SYNC-004，《接口文档》§12.1.3）。
 *
 * push 与 resolve 两个方向都要碰冲突记录，这里收口两件共享的事：
 * - `record`：CAS 失败 → 记下"本地与服务端各是什么"，交给用户二选；
 * - `keepLocal`：用户选了"以本地为准" → 用本地内容**强制**覆盖服务端实体。
 *
 * `keepLocal` 必须走 `SyncApplyPort`（而不是自己拼 UPDATE）：实体字段的可写集合、
 * 时间列的形态转换都只有注册表那一份真相，绕过它就会在冲突解决这条路径上
 * 悄悄引入第二份实现。
 */
import { InvariantError, ValidationError } from '@/shared/errors/app-error.ts';

import type { SyncApplyPort } from '../domain/sync-repository.ts';
import type {
  RecordConflictInput,
  SyncConflict,
  SyncConflictRepository,
} from '../domain/sync-conflict.ts';

export interface ConflictServiceDependencies {
  readonly conflicts: SyncConflictRepository;
  readonly apply: SyncApplyPort;
}

export class ConflictService {
  readonly #conflicts: SyncConflictRepository;
  readonly #apply: SyncApplyPort;

  constructor(dependencies: ConflictServiceDependencies) {
    this.#conflicts = dependencies.conflicts;
    this.#apply = dependencies.apply;
  }

  /** 记录（或刷新）一条待处理冲突；同一实体复用同一行，`conflictId` 因此稳定。 */
  record(userId: string, input: RecordConflictInput): Promise<SyncConflict> {
    return this.#conflicts.record(userId, input);
  }

  /**
   * `keep_local`：把本地内容覆盖到服务端实体。
   *
   * `baseVersion` 传 `null` 即**不做版本校验**——用户已经看过两边的内容并做出了选择，
   * 此刻再拿旧版本去 CAS 只会必然失败，"以本地为准"的语义就是无条件覆盖。
   *
   * @throws {ValidationError} 本地内容不可用（记录里没存 payload）或写不进去时抛出。
   */
  async keepLocal(userId: string, conflict: SyncConflict): Promise<void> {
    if (conflict.localPayload === null) {
      throw new ValidationError('该冲突没有可用的本地内容，无法选择「以本地为准」');
    }

    const outcome = await this.#apply.apply(userId, {
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      // 冲突记录不保存操作类型：本地内容一律按"覆盖"写入。对 create 类的冲突而言
      // 服务端已有该行，覆盖写正是"以本地为准"应有的效果；对 delete 类的冲突，
      // 覆盖写会把实体的字段恢复成客户端快照的样子（墓碑由服务端版本决定，不在此处翻转）。
      operationType: 'update',
      baseVersion: null,
      payload: conflict.localPayload,
    });

    if (outcome.outcome === 'rejected') {
      throw new ValidationError(`无法以本地内容覆盖服务端实体：${outcome.reason}`);
    }
    if (outcome.outcome === 'conflict') {
      // 关掉版本校验后不该再产生冲突；真走到这里说明实现与契约脱节，明确报内部错误。
      throw new InvariantError({ message: '强制覆盖不应产生新的版本冲突' });
    }
  }
}
