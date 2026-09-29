/**
 * 支出分类（EXP-001，《数据库设计文档》§4.9、SRS FR-051）。
 *
 * 与生活领域（§4.2）三列同构（`sort_order` / `is_default` / `is_archived`），这是刻意的：
 * 两者都是"用户可整理的枚举"，用户对它们的预期也一致——**能改名、能停用、顺序稳定**。
 * 分开设计只会让同一套交互在两处出现两套语义。
 */

/** 名称长度上限（§4.9 的 `varchar(60)`）。 */
export const EXPENSE_CATEGORY_NAME_MAX_LENGTH = 60;

/** 领域实体。 */
export interface ExpenseCategory {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly sortOrder: number;
  /** 是否由惰性播种写入（用户可改名、可停用，此标记仅作来源记录）。 */
  readonly isDefault: boolean;
  readonly isArchived: boolean;
  readonly version: number;
}

/** 播种一个分类所需的最小信息。 */
export interface ExpenseCategorySeed {
  readonly name: string;
  readonly sortOrder: number;
}

/** 创建分类的输入（已通过校验）。 */
export interface ExpenseCategoryCreateInput {
  readonly name: string;
}

/**
 * 更新分类的补丁：键存在即"要改这一项"。
 *
 * 值类型显式带 `| undefined`：项目启用了 `exactOptionalPropertyTypes`，
 * 而校验层（Zod）产出的可选字段天然含 `undefined`。与 `LifeAreaPatch` 同一条理由。
 */
export interface ExpenseCategoryPatch {
  readonly name?: string | undefined;
  readonly isArchived?: boolean | undefined;
}
