/**
 * 支出分类仓储端口（EXP-001，《详细设计说明书》§（仓储依赖纪律））。
 *
 * 纪律与 `LifeAreaRepository` 完全相同，理由也相同：
 *
 * - **每个方法都带 `userId`**——用户作用域是强制表达。端口上只要存在一次"不带
 *   userId 的查询"，实现侧就总有机会写出全表读，而那种读在本地单用户环境下
 *   永远看不出问题。
 * - **非本人 id 一律 `null`**——查询返 `null`、由用例转 `NotFoundError`（不泄露存在性）。
 *   端口层不抛异常，是为了让 fake 实现与真实实现的行为在这点上完全相同。
 *
 * ## 本批不提供 `delete`
 *
 * SRS FR-051 的删除语义是「停用」：置 `is_archived`、不删行，历史开销关联保持可解析。
 * 接口文档 §9 明文「本批不提供 DELETE」（A6）。端口因此没有 delete 方法——
 * 留一个没有写入路径的方法，等于给了"顺手物理删除"的入口。
 */
import type {
  ExpenseCategory,
  ExpenseCategoryCreateInput,
  ExpenseCategoryPatch,
} from './expense-category.ts';

export interface ListExpenseCategoriesOptions {
  /** 是否包含已停用项（接口文档 §GET /expense-categories 的 `includeArchived`）。 */
  readonly includeArchived: boolean;
}

export interface ExpenseCategoryRepository {
  /**
   * 按 `sortOrder` 升序列出该用户的分类，**调用即保证默认分类已就绪**。
   *
   * 惰性播种落在这里（而不是建会话时）：分类只有进入「开销」功能才需要，
   * 首启就播种会让不用记账的用户多出九行无意义数据（披露 E 审定口径）。
   */
  listByUser(
    userId: string,
    options: ListExpenseCategoriesOptions,
  ): Promise<readonly ExpenseCategory[]>;

  /** 按 id 查单个分类（**含已停用**：恢复停用正是通过 `update({ isArchived: false })` 完成）。 */
  findById(userId: string, categoryId: string): Promise<ExpenseCategory | null>;

  /**
   * 创建分类，`sortOrder` 由实现取当前末位 + 1。
   *
   * 与 `listByUser` 同样先保证默认分类就绪：若用户先 POST 再 GET，默认分类会
   * 永远不出现，而新建项还会占用本该属于「餐饮」的首位序号。
   *
   * @throws {ConflictError} 同用户已有未停用的同名分类时（§4.9 的部分唯一索引兜底）。
   */
  create(userId: string, input: ExpenseCategoryCreateInput): Promise<ExpenseCategory>;

  /** 重命名 / 停用。 */
  update(userId: string, categoryId: string, patch: ExpenseCategoryPatch): Promise<ExpenseCategory>;
}
