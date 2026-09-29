/**
 * 支出分类管理的用例（EXP-001，SRS FR-051）。
 *
 * 覆盖列表、新增、重命名与停用；**不提供物理删除**——SRS FR-051 的删除语义是
 * 「停用不删历史开销」，物理删除会让"这笔记当初算在哪一类"永远无法回答。
 */
import { NotFoundError, ValidationError } from '@/shared/errors/app-error.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import type { AuditEventType, AuditLogger } from '@/shared/telemetry/audit-event.ts';

import type {
  ExpenseCategory,
  ExpenseCategoryCreateInput,
  ExpenseCategoryPatch,
} from '../domain/expense-category.ts';
import type { ExpenseCategoryRepository } from '../domain/expense-category-repository.ts';

export interface ManageExpenseCategoryDependencies {
  readonly expenseCategories: ExpenseCategoryRepository;
  readonly audit: AuditLogger;
}

export class ManageExpenseCategoryUseCase {
  readonly #expenseCategories: ExpenseCategoryRepository;
  readonly #audit: AuditLogger;

  constructor(dependencies: ManageExpenseCategoryDependencies) {
    this.#expenseCategories = dependencies.expenseCategories;
    this.#audit = dependencies.audit;
  }

  /** 列表（含惰性播种，见端口注释）。 */
  list(userId: string, includeArchived: boolean): Promise<readonly ExpenseCategory[]> {
    return this.#expenseCategories.listByUser(userId, { includeArchived });
  }

  async create(
    userId: string,
    input: ExpenseCategoryCreateInput,
    requestId?: string,
  ): Promise<ExpenseCategory> {
    const created = await this.#expenseCategories.create(userId, input);
    this.#record('DATA_CREATED', userId, requestId);
    return created;
  }

  /**
   * 重命名 / 停用。
   *
   * 「重复停用」与「重复恢复」都按 `VALIDATION_ERROR` 处理（《接口文档》
   * §PATCH /expense-categories/{categoryId}：「重复停用返回 422」）。与生活领域
   * 归档同一条理由：不做静默幂等——用户点两次停用通常意味着界面状态与服务端
   * 不同步，悄悄接受会让那个不同步一直存在。
   */
  async update(
    userId: string,
    categoryId: string,
    patch: ExpenseCategoryPatch,
    requestId?: string,
  ): Promise<ExpenseCategory> {
    const current = await this.#expenseCategories.findById(userId, categoryId);
    if (current === null) {
      throw new NotFoundError('支出分类不存在');
    }

    if (patch.isArchived === true && current.isArchived) {
      throw new ValidationError('该支出分类已经停用');
    }
    if (patch.isArchived === false && !current.isArchived) {
      throw new ValidationError('该支出分类尚未停用');
    }

    const updated = await this.#expenseCategories.update(userId, categoryId, patch);

    // 停用与恢复用各自的事件类型，而不是一律 `DATA_UPDATED`：审计查询最常问的就是
    // "这条数据是什么时候被移除/恢复的"，混在"有过更新"里等于答不了。
    let eventType: AuditEventType = 'DATA_UPDATED';
    if (patch.isArchived === true) {
      eventType = 'DATA_DELETED';
    } else if (patch.isArchived === false) {
      eventType = 'DATA_RESTORED';
    }
    this.#record(eventType, userId, requestId);

    return updated;
  }

  /** 写审计事件。只记事件类型与匿名用户标识，不含分类内容。 */
  #record(type: AuditEventType, userId: string, requestId: string | undefined): void {
    this.#audit.record({
      type,
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
}
