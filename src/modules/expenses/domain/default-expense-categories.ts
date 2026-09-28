/**
 * 默认支出分类名单（EXP-001，SRS FR-051「系统提供默认分类，例如餐饮、交通、居住、
 * 健康、学习、娱乐、购物、关系、其他」）。
 *
 * 名称与 `sortOrder`（1–9）都是**冻结值**：改名会让已播种的用户与新用户看到两套分类，
 * 而分类的价值恰恰来自"大家指的是同一件事"；顺序则是「记一笔」默认选中项的落点
 * （A2：默认分类取列表首项），顺序一变默认值就变。
 *
 * ## 播种条件（冻结）
 *
 * 该用户在 `expense_categories` 中**一行都没有（含已停用）**时**整体写入**九行
 * ——与 §4.8 对 `life_areas` 的口径一致，是「首次播种」而不是「逐项补齐」。
 * 用户改名、停用、甚至把九个分类全部停用后重启，默认项都**不会复活**：
 * 复活会覆盖用户已经做出的整理。
 *
 * 判据是「行数为 0」而非「这个名字还没有」，因此本文件同样不需要 `seed_key` 列。
 */
import type { ExpenseCategorySeed } from './expense-category.ts';

export const DEFAULT_EXPENSE_CATEGORIES: readonly ExpenseCategorySeed[] = Object.freeze([
  { sortOrder: 1, name: '餐饮' },
  { sortOrder: 2, name: '交通' },
  { sortOrder: 3, name: '居住' },
  { sortOrder: 4, name: '健康' },
  { sortOrder: 5, name: '学习' },
  { sortOrder: 6, name: '娱乐' },
  { sortOrder: 7, name: '购物' },
  { sortOrder: 8, name: '关系' },
  { sortOrder: 9, name: '其他' },
]);
