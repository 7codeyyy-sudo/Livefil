/**
 * 开销仓储端口（EXP-001，《详细设计说明书》§（仓储依赖纪律））。
 *
 * 纪律与前几个模块相同：**每个方法都带 `userId`**（用户作用域是强制表达），
 * **非本人 id 一律 `null` / `false`**（不泄露存在性）。
 *
 * ## 软删是唯一删除语义
 *
 * `softDelete` 置 `deleted_at`，不做物理删除：FR-052 的撤销窗口（A4「点撤销 →
 * 恢复请求」）依赖这一行仍然存在。所有查询都排除已软删行，因此"删掉"对用户而言
 * 与真删无异，而对系统保留了恢复的可能。
 */
import type { Expense, ExpenseCreateInput, ExpensePatch } from './expense.ts';

/** 列表查询条件（接口文档 §9 `GET /expenses`）。 */
export interface ListExpensesOptions {
  /** 日历日范围（`YYYY-MM-DD`，按用户时区解释），作用于 `occurredOn`。 */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly lifeAreaId?: string | undefined;
  readonly goalId?: string | undefined;
  /** 不透明游标；首页不传。 */
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/** 分页结果：游标在 `meta` 里，由响应信封透传。 */
export interface ExpensePage {
  readonly items: readonly Expense[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface ExpenseRepository {
  /** 按 id 读取**未软删**的开销；不存在、已软删或非本人一律 `null`。 */
  findById(userId: string, expenseId: string): Promise<Expense | null>;

  /** 列表查询（排序键固定 `occurred_on desc, created_at desc`，游标不透明）。 */
  list(userId: string, options: ListExpensesOptions): Promise<ExpensePage>;

  /** 创建开销（关联实体的归属校验由用例先行完成）。 */
  create(userId: string, input: ExpenseCreateInput): Promise<Expense>;

  /** 乐观并发更新：`expectedVersion` 不匹配抛 `ConflictError`，找不到行抛 `NotFoundError`。 */
  update(
    userId: string,
    expenseId: string,
    expectedVersion: number,
    patch: ExpensePatch,
  ): Promise<Expense>;

  /**
   * 软删：置 `deleted_at` 并返回被删行（含 `deletedAt` 与 `version`，供撤销使用）。
   * 行不存在 / 已删 / 非本人返回 `null`。
   *
   * 必须经 `update()` 完成：同步链路的 `changeAt = coalesce(updated_at, created_at)`
   * 依赖它前移，绕过 ORM 的裸 SQL 会让这次删除**对增量拉取不可见**。
   */
  softDelete(userId: string, expenseId: string): Promise<Expense | null>;

  /**
   * 撤销删除：清 `deleted_at`（FR-052 / A4 的撤销窗口）。
   *
   * 带 `expectedVersion` 是刻意的：撤销与编辑可能同时发生，无条件恢复会覆盖
   * 用户刚做的编辑。行不处于"已软删"状态时抛 `NotFoundError`——本接口不是
   * 通用的"复活一切"入口。
   */
  restore(userId: string, expenseId: string, expectedVersion: number): Promise<Expense>;
}
