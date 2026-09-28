/**
 * 开销（EXP-001，DB §4.10、SRS FR-050）。
 *
 * ## 金额为什么是字符串
 *
 * `expenses.amount_minor` 是 `bigint`（`mode: 'bigint'`），域对象与跨线载体一律用
 * **字符串**：`number` 在超过 2^53 之后会静默丢精度，而"一分钱算错"在这条链路上
 * 是最致命的失败（PD-20260928-007 风险 2）。字符串是唯一在 JS 侧无损的整数载体，
 * 仓储在边界上做 `BigInt ↔ string` 转换，任何环节都不得出现 `Number()`。
 *
 * ## 日期为什么是字符串
 *
 * `occurred_on` 是 `date` 列：「这笔记在哪一天」是日历日，不是瞬时。转成
 * `Date` 再序列化会引入时区偏移，让一笔 23:30 的开销跳到第二天。
 */
import { ValidationError } from '@/shared/errors/app-error.ts';

/** ISO 4217 代码长度（§4.10 的 `char(3)`）。 */
export const EXPENSE_CURRENCY_CODE_LENGTH = 3;

/** 支付方式长度上限（§4.10 的 `varchar(40)`）。 */
export const EXPENSE_PAYMENT_METHOD_MAX_LENGTH = 40;

/** 来源取值（§4.10 的 `varchar(24)`）。 */
export const EXPENSE_SOURCES = ['manual', 'ai_draft', 'import'] as const;

export type ExpenseSource = (typeof EXPENSE_SOURCES)[number];

/**
 * 金额的最小货币单位正整数形状。
 *
 * 刻意**不**接受 `+36`、`1e3`、`36.0`、`0`、`-1`：它们都能表示成合法的大整数，
 * 但接受其中任何一个都意味着"金额的书写形式"成了自由变量，而客户端与服务端
 * 对同一个数字的解释必须完全一致（接口文档 §9：「金额一次落库后不接受浮点或
 * 科学计数法字符串」）。
 */
const AMOUNT_MINOR_PATTERN = /^[1-9]\d*$/;

/** 领域实体。 */
export interface Expense {
  readonly id: string;
  readonly userId: string;
  readonly categoryId: string;
  readonly lifeAreaId: string | null;
  /**
   * 父目标与行动**两列独立并存**（披露 D）：选中行动时同时落 `actionId` 与其父目标
   * `goalId`，因此 `groupBy=goal` 是单列过滤、无需 JOIN `actions`。
   */
  readonly goalId: string | null;
  readonly actionId: string | null;
  /** 最小货币单位整数**字符串**（36 元＝`"3600"`）。 */
  readonly amountMinor: string;
  readonly currencyCode: string;
  /** 用户时区日历日 `YYYY-MM-DD`。 */
  readonly occurredOn: string;
  readonly paymentMethod: string | null;
  readonly note: string | null;
  readonly source: ExpenseSource;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly version: number;
}

/** 创建开销的输入（已通过校验）。 */
export interface ExpenseCreateInput {
  readonly categoryId: string;
  readonly lifeAreaId: string | null;
  readonly goalId: string | null;
  readonly actionId: string | null;
  readonly amountMinor: string;
  readonly currencyCode: string;
  readonly occurredOn: string;
  readonly paymentMethod: string | null;
  readonly note: string | null;
  readonly source: ExpenseSource;
}

/**
 * 更新开销的补丁：键存在即"要改这一项"。
 *
 * 可空字段的值类型含 `null`——「解除关联」是一次真实的修改，与"不改这一项"
 * （`undefined`）必须可区分，否则用户永远无法把一笔开销从目标上摘下来。
 * 值类型显式带 `| undefined` 是因为项目启用了 `exactOptionalPropertyTypes`。
 */
export interface ExpensePatch {
  readonly categoryId?: string | undefined;
  readonly lifeAreaId?: string | null | undefined;
  readonly goalId?: string | null | undefined;
  readonly actionId?: string | null | undefined;
  readonly amountMinor?: string | undefined;
  readonly currencyCode?: string | undefined;
  readonly occurredOn?: string | undefined;
  readonly paymentMethod?: string | null | undefined;
  readonly note?: string | null | undefined;
  readonly source?: ExpenseSource | undefined;
}

/**
 * 校验并转换金额字符串为大整数。
 *
 * 放在领域层：它是"什么叫合法金额"的唯一定义处，仓储在写入前调用它，因此
 * 绕过 HTTP 校验的调用路径（同步 apply、脚本、将来的导入）同样拦得住。
 *
 * @throws {ValidationError} 不是最小货币单位的正整数时。
 */
export function parseAmountMinor(value: string): bigint {
  if (!AMOUNT_MINOR_PATTERN.test(value)) {
    throw new ValidationError('金额必须是正整数的最小货币单位字符串（如 "3600"）', {
      fields: { amountMinor: '金额必须是正整数的最小货币单位字符串' },
    });
  }
  return BigInt(value);
}

/** 大整数 → 金额字符串（回读用；不回退到 `Number()`）。 */
export function formatAmountMinor(value: bigint): string {
  return value.toString();
}

/** 判断任意字符串是否为合法来源（用于运行时校验的收口）。 */
export function isExpenseSource(value: string): value is ExpenseSource {
  return (EXPENSE_SOURCES as readonly string[]).includes(value);
}
