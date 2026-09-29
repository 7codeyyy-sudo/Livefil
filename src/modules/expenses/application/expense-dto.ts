/**
 * 开销的对外 DTO 与请求校验（EXP-002/004，《接口文档》§9）。
 *
 * DTO 与校验放同一个文件——两者描述的是同一个边界（HTTP 出入参），拆开会让人在改
 * 字段时只改一半。
 */
import { z } from 'zod';

import {
  EXPENSE_NOTE_MAX_LENGTH,
  EXPENSE_PAYMENT_METHOD_MAX_LENGTH,
  EXPENSE_SOURCES,
  type Expense,
} from '../domain/expense.ts';
import {
  EXPENSE_SUMMARY_GROUP_BY,
  type ExpenseSummary,
  type ExpenseSummaryGroupBy,
} from '../domain/expense-repository.ts';

/**
 * `GET/POST/PATCH /expenses` 响应中的单项。
 *
 * 刻意**不透出** `userId`（由会话隐含）；`deletedAt` 保留——DELETE 的响应正是靠它
 * 承载「可撤销信息」（A4 第 2 步）。
 */
export interface ExpenseDto {
  readonly id: string;
  readonly categoryId: string;
  readonly lifeAreaId: string | null;
  readonly goalId: string | null;
  readonly actionId: string | null;
  /** 最小货币单位整数**字符串**。 */
  readonly amountMinor: string;
  readonly currencyCode: string;
  readonly occurredOn: string;
  readonly paymentMethod: string | null;
  readonly note: string | null;
  readonly source: string;
  readonly deletedAt: string | null;
  readonly version: number;
}

export function toExpenseDto(expense: Expense): ExpenseDto {
  return {
    id: expense.id,
    categoryId: expense.categoryId,
    lifeAreaId: expense.lifeAreaId,
    goalId: expense.goalId,
    actionId: expense.actionId,
    amountMinor: expense.amountMinor,
    currencyCode: expense.currencyCode,
    occurredOn: expense.occurredOn,
    paymentMethod: expense.paymentMethod,
    note: expense.note,
    source: expense.source,
    deletedAt: expense.deletedAt,
    version: expense.version,
  };
}

/** 摘要响应（结构与领域一致；这里显式声明是为了让接口形状不随领域内部改名而漂移）。 */
export interface ExpenseSummaryDto {
  readonly groups: readonly {
    readonly key: string | null;
    readonly label: string;
    readonly totals: readonly {
      readonly currencyCode: string;
      readonly totalMinor: string;
      readonly count: number;
    }[];
  }[];
  readonly grandTotals: readonly {
    readonly currencyCode: string;
    readonly totalMinor: string;
    readonly count: number;
  }[];
}

export function toExpenseSummaryDto(summary: ExpenseSummary): ExpenseSummaryDto {
  return { groups: summary.groups, grandTotals: summary.grandTotals };
}

/**
 * 金额：最小货币单位正整数。
 *
 * 上限 19 位＝`bigint` 的十进制容量；超出直接拒掉，而不是让它到数据库才报错。
 * 刻意不接受 `+36`、`1e3`、`36.0`、`0`、`-1`（与领域层 `parseAmountMinor` 同一口径）。
 */
const amountMinorField = z
  .string()
  .regex(/^[1-9]\d{0,18}$/, { message: '金额必须是最小货币单位的正整数（如 "3600"）' });

/** 币种：三字母 ISO 4217，大小写归一为大写（`char(3)` 存的是规范形式）。 */
const currencyCodeField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, { message: '币种必须是三字母 ISO 4217 代码' });

/** 日历日（YYYY-MM-DD）；`date` 列只接受这种形状。 */
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: '日期格式应为 YYYY-MM-DD' });

const uuidField = z.uuid();

/** 可空字段统一形状：JSON null 与"未提供"在补丁判定里都可区分。 */
const optionalNullable = <T extends z.ZodType>(inner: T) => inner.nullish();

/** 可选文本：去空白后空串按"未填"处理（存 `null`，不存 `''`）。 */
const optionalText = (maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength, { message: `不能超过 ${String(maxLength)} 个字符` })
    .transform((value) => (value === '' ? null : value))
    .nullish();

export const createExpenseSchema = z
  .object({
    amountMinor: amountMinorField,
    currencyCode: currencyCodeField,
    categoryId: uuidField,
    occurredOn: calendarDay,
    lifeAreaId: optionalNullable(uuidField),
    goalId: optionalNullable(uuidField),
    actionId: optionalNullable(uuidField),
    paymentMethod: optionalText(EXPENSE_PAYMENT_METHOD_MAX_LENGTH),
    note: optionalText(EXPENSE_NOTE_MAX_LENGTH),
    source: z.enum(EXPENSE_SOURCES).default('manual'),
  })
  .strict();

export const updateExpenseSchema = z
  .object({
    version: z.number().int().positive(),
    amountMinor: amountMinorField.optional(),
    currencyCode: currencyCodeField.optional(),
    categoryId: uuidField.optional(),
    occurredOn: calendarDay.optional(),
    lifeAreaId: optionalNullable(uuidField),
    goalId: optionalNullable(uuidField),
    actionId: optionalNullable(uuidField),
    paymentMethod: optionalText(EXPENSE_PAYMENT_METHOD_MAX_LENGTH),
    note: optionalText(EXPENSE_NOTE_MAX_LENGTH),
    source: z.enum(EXPENSE_SOURCES).optional(),
  })
  .strict()
  // 只有 version 的补丁是"成功但什么都没改"，用户以为保存了。明确拒绝。
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
    message: '至少需要提供一个要修改的字段',
  });

/** DELETE 之后的撤销请求（A4 第 3 步：清 `deleted_at` 带 `version`）。 */
export const restoreExpenseSchema = z.object({ version: z.number().int().positive() }).strict();

export const listExpensesQuerySchema = z
  .object({
    from: calendarDay.optional(),
    to: calendarDay.optional(),
    categoryId: uuidField.optional(),
    lifeAreaId: uuidField.optional(),
    goalId: uuidField.optional(),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const summarizeExpensesQuerySchema = z
  .object({
    from: calendarDay.optional(),
    to: calendarDay.optional(),
    groupBy: z.enum(EXPENSE_SUMMARY_GROUP_BY).default('category'),
  })
  .strict();

export type CreateExpenseRequest = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseRequest = z.infer<typeof updateExpenseSchema>;
export type RestoreExpenseRequest = z.infer<typeof restoreExpenseSchema>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;
export type SummarizeExpensesQuery = {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly groupBy: ExpenseSummaryGroupBy;
};
