/**
 * 支出分类的对外 DTO 与请求校验（EXP-001，《接口文档》§9）。
 *
 * DTO 与校验放同一个文件：两者描述的是同一个边界（HTTP 出入参），分开会让人在改
 * 字段时只改一半——尤其"新增字段要同时加校验与映射"这种事，放在一起最不容易漏。
 */
import { z } from 'zod';

import {
  EXPENSE_CATEGORY_NAME_MAX_LENGTH,
  type ExpenseCategory,
} from '../domain/expense-category.ts';

/** `GET/POST/PATCH /expense-categories` 响应中的单项。 */
export interface ExpenseCategoryDto {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly isDefault: boolean;
  readonly isArchived: boolean;
  readonly version: number;
}

export function toExpenseCategoryDto(category: ExpenseCategory): ExpenseCategoryDto {
  return {
    id: category.id,
    name: category.name,
    sortOrder: category.sortOrder,
    isDefault: category.isDefault,
    isArchived: category.isArchived,
    version: category.version,
  };
}

/** 名称：去掉首尾空白后校验长度。 */
const categoryName = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { message: '分类名称不能为空' })
  .refine((value) => value.length <= EXPENSE_CATEGORY_NAME_MAX_LENGTH, {
    message: `分类名称不能超过 ${String(EXPENSE_CATEGORY_NAME_MAX_LENGTH)} 个字符`,
  });

export const createExpenseCategorySchema = z.object({ name: categoryName }).strict();

export const updateExpenseCategorySchema = z
  .object({
    name: categoryName.optional(),
    isArchived: z.boolean().optional(),
  })
  .strict()
  // 空补丁会被当成"成功但什么都没改"，用户以为保存了。明确拒绝。
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要提供一个要修改的字段' });

export type CreateExpenseCategoryRequest = z.infer<typeof createExpenseCategorySchema>;
export type UpdateExpenseCategoryRequest = z.infer<typeof updateExpenseCategorySchema>;
