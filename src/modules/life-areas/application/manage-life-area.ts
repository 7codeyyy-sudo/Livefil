/**
 * 生活领域管理的用例（IAM-003，《详细设计说明书》§4.8）。
 *
 * 覆盖创建、重命名、排序、归档与恢复；**不提供物理删除**（§4.8）：归档保留历史
 * 关联，而物理删除会让"这条任务当初属于哪个领域"永远无法回答。
 */
import { NotFoundError, ValidationError } from '@/shared/errors/app-error.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import type { AuditLogger, AuditEventType } from '@/shared/telemetry/audit-event.ts';

import type { LifeArea, LifeAreaCreateInput, LifeAreaPatch } from '../domain/life-area.ts';
import type { LifeAreaRepository } from '../domain/life-area-repository.ts';

export interface ManageLifeAreaDependencies {
  readonly lifeAreas: LifeAreaRepository;
  readonly audit: AuditLogger;
}

export class ManageLifeAreaUseCase {
  readonly #lifeAreas: LifeAreaRepository;
  readonly #audit: AuditLogger;

  constructor(dependencies: ManageLifeAreaDependencies) {
    this.#lifeAreas = dependencies.lifeAreas;
    this.#audit = dependencies.audit;
  }

  list(userId: string, includeArchived: boolean): Promise<readonly LifeArea[]> {
    return this.#lifeAreas.listByUser(userId, { includeArchived });
  }

  async create(userId: string, input: LifeAreaCreateInput, requestId?: string): Promise<LifeArea> {
    const created = await this.#lifeAreas.create(userId, input);
    this.#record('DATA_CREATED', userId, requestId);
    return created;
  }

  /**
   * 更新名称 / 颜色 / 归档状态。
   *
   * 「重复归档」与「重复恢复」都按 `VALIDATION_ERROR` 处理（《接口文档》
   * §PATCH /life-areas/{id}：「重复归档返回 422」）。不做静默幂等：用户点两次
   * 归档通常意味着界面状态与服务端不同步，悄悄接受会让那个不同步一直存在。
   */
  async update(
    userId: string,
    lifeAreaId: string,
    patch: LifeAreaPatch,
    requestId?: string,
  ): Promise<LifeArea> {
    const current = await this.#lifeAreas.findById(userId, lifeAreaId);
    if (current === null) {
      throw new NotFoundError('生活领域不存在');
    }

    if (patch.isArchived === true && current.isArchived) {
      throw new ValidationError('该生活领域已经归档');
    }
    if (patch.isArchived === false && !current.isArchived) {
      throw new ValidationError('该生活领域尚未归档');
    }

    const updated = await this.#lifeAreas.update(userId, lifeAreaId, patch);

    // 归档与恢复用各自的事件类型，而不是一律 `DATA_UPDATED`：审计查询最常问的
    // 就是"这条数据是什么时候被移除/恢复的"，混在"有过更新"里等于答不了。
    let eventType: AuditEventType = 'DATA_UPDATED';
    if (patch.isArchived === true) {
      eventType = 'DATA_DELETED';
    } else if (patch.isArchived === false) {
      eventType = 'DATA_RESTORED';
    }
    this.#record(eventType, userId, requestId);

    return updated;
  }

  /**
   * 按给定顺序重排全部未归档领域。
   *
   * 集合一致性（"多一个 / 少一个 / 含他人 id"）由仓储在事务内用领域层的纯函数
   * 校验——放在这里做会与写入之间存在窗口。
   */
  async reorder(
    userId: string,
    orderedIds: readonly string[],
    requestId?: string,
  ): Promise<readonly LifeArea[]> {
    const reordered = await this.#lifeAreas.reorderActive(userId, orderedIds);
    this.#record('DATA_UPDATED', userId, requestId);
    return reordered;
  }

  /** 写审计事件。只记事件类型与匿名用户标识，不含领域内容（§4.8 与 SRS §6.7 的口径）。 */
  #record(type: AuditEventType, userId: string, requestId: string | undefined): void {
    this.#audit.record({
      type,
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
}
