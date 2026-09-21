/**
 * 任务的对外 DTO 与请求校验（TASK-002/003，《接口文档》§4）。
 *
 * DTO 与校验放同一个文件——两者描述的是同一个边界（HTTP 出入参），拆开会让人
 * 在改字段时只改一半（life-area-dto.ts 的同一条理由）。
 */
import { z } from 'zod';

import {
  TASK_REASON_CODES,
  TASK_STATUSES,
  TASK_TITLE_MAX_LENGTH,
  type Task,
} from '../domain/task.ts';

/** `GET/POST /tasks` 与任务端点响应中的单项。 */
export interface TaskDto {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly lifeAreaId: string | null;
  readonly goalId: string | null;
  readonly actionId: string | null;
  readonly dueDate: string | null;
  readonly estimatedMinutes: number | null;
  readonly minimumVersion: string | null;
  readonly version: number;
}

/**
 * 实体 → DTO。
 *
 * 刻意**不透出**：`userId`（由会话隐含）、`recurrenceRule`（例程属后续批次，
 * 本批恒为 null，透出只会让客户端以为已有重复任务语义）、`deletedAt`（软删
 * 是实现细节，删除后的任务不出现在任何查询中）、`source`（AI/导入来源随
 * 各自批次才有意义）。
 */
export function toTaskDto(task: Task): TaskDto {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    lifeAreaId: task.lifeAreaId,
    goalId: task.goalId,
    actionId: task.actionId,
    dueDate: task.dueDate,
    estimatedMinutes: task.estimatedMinutes,
    minimumVersion: task.minimumVersion,
    version: task.version,
  };
}

/** 标题：去首尾空白后校验非空与长度（§4.5 `varchar(240)`）。 */
const taskTitle = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { message: '标题不能为空' })
  .refine((value) => value.length <= TASK_TITLE_MAX_LENGTH, {
    message: `标题不能超过 ${String(TASK_TITLE_MAX_LENGTH)} 个字符`,
  });

/** 日历日（YYYY-MM-DD）；`date` 列只接受这种形状。 */
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: '日期格式应为 YYYY-MM-DD' });

const uuidField = z.uuid();

/** 可空字段统一形状：JSON null 与"未提供"在补丁判定里都可区分。 */
const optionalNullable = <T extends z.ZodType>(inner: T) => inner.nullish();

export const createTaskSchema = z
  .object({
    title: taskTitle,
    // 初始状态只能是收件箱或已安排（「保存到指定日期」）：从无到有没有"流转"可言，
    // 其余取值（completed 等）等于要求服务端凭空造出一个已完成任务。
    status: z.enum(['inbox', 'planned']).default('inbox'),
    lifeAreaId: optionalNullable(uuidField),
    dueDate: optionalNullable(calendarDay),
    estimatedMinutes: optionalNullable(z.number().int().positive()),
    minimumVersion: optionalNullable(z.string().max(160)),
    goalId: optionalNullable(uuidField),
    actionId: optionalNullable(uuidField),
  })
  .strict();

export const updateTaskSchema = z
  .object({
    version: z.number().int().positive(),
    title: taskTitle.optional(),
    lifeAreaId: optionalNullable(uuidField),
    dueDate: optionalNullable(calendarDay),
    estimatedMinutes: optionalNullable(z.number().int().positive()),
    minimumVersion: optionalNullable(z.string().max(160)),
    goalId: optionalNullable(uuidField),
    actionId: optionalNullable(uuidField),
  })
  .strict();

export const taskStatusChangeSchema = z
  .object({
    status: z.enum(TASK_STATUSES),
    reasonCode: z.enum(TASK_REASON_CODES).nullish(),
    note: optionalNullable(z.string().max(500)),
    actualMinutes: optionalNullable(z.number().int().positive()),
    actualAmount: optionalNullable(z.string().max(160)),
  })
  .strict();

export const batchTasksSchema = z
  .object({
    taskIds: z.array(uuidField).min(1, '至少选择一条任务').max(100, '一次最多操作 100 条任务'),
    operation: z.enum(['archive', 'schedule']),
    dueDate: optionalNullable(calendarDay),
    lifeAreaId: optionalNullable(uuidField),
  })
  .strict();

export const convertToActionSchema = z
  .object({
    goalId: uuidField,
    name: taskTitle.optional(),
    minimumVersion: optionalNullable(z.string().max(160)),
    estimatedMinutes: optionalNullable(z.number().int().positive()),
  })
  .strict();

/**
 * `GET /tasks` 的查询参数（接口文档 §4 / §1.3）。
 *
 * 排序键固定 `created_at desc`（无参数）；`limit` 默认 20、上限 100——
 * 上限的存在让"忘了截断"的客户端最多拿到 100 条，而不是拖垮响应。
 * 游标不透明：客户端只原样回传，不解析（§1.3 的既定口径）。
 */
export const listTasksQuerySchema = z
  .object({
    status: z.enum(TASK_STATUSES).optional(),
    from: calendarDay.optional(),
    to: calendarDay.optional(),
    lifeAreaId: uuidField.optional(),
    goalId: uuidField.optional(),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
