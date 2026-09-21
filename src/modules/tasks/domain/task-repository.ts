/**
 * 任务仓储端口（TASK-001）。
 *
 * **端口必须放 `domain/`**：`modules/<模块>/infrastructure` 被禁止引用
 * `application`，端口若定义在应用层，实现它就违规（Phase 2 的既定结论）。
 * 路由处理器只依赖这里的接口，集成测试注入 fake。
 */
import type { Task, TaskCreateInput, TaskPatch, TaskStatus } from './task.ts';

/** 收件箱/列表查询条件（接口文档 §4 `GET /tasks`）。 */
export interface ListTasksOptions {
  readonly status?: TaskStatus | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly lifeAreaId?: string | undefined;
  readonly goalId?: string | undefined;
  /** 不透明游标；首页不传。 */
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/** 分页结果：游标在 `meta` 里，由响应信封透传（UI-005 的「加载更多」读它）。 */
export interface TaskPage {
  readonly items: readonly Task[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** 单条状态流转的结果：新状态与新版本（供审计事件与响应使用）。 */
export interface TaskStatusUpdateResult {
  readonly task: Task;
}

export interface TaskRepository {
  /** 按 id 读取**未删除**的任务；不存在、已软删或不属于该用户一律 `null`。 */
  findById(userId: string, taskId: string): Promise<Task | null>;

  /** 列表查询（排序键固定 `created_at desc`，游标不透明）。 */
  list(userId: string, options: ListTasksOptions): Promise<TaskPage>;

  /** 创建任务（关联实体的归属校验由用例先行完成）。 */
  create(userId: string, input: TaskCreateInput): Promise<Task>;

  /**
   * 乐观并发更新：`expectedVersion` 不匹配时抛 `ConflictError`（409），
   * 找不到行抛 `NotFoundError`（作用域不匹配与不存在同义，不泄露存在性）。
   */
  update(userId: string, taskId: string, expectedVersion: number, patch: TaskPatch): Promise<Task>;

  /**
   * 状态流转：与 `update` 分开是因为它同时写状态与"状态事件所需"的上下文，
   * 且**不受 version 约束**——状态流转走事件而非编辑语义（接口文档 §4）。
   */
  updateStatus(
    userId: string,
    taskId: string,
    to: TaskStatus,
    extras: {
      readonly actualMinutes: number | null;
      readonly actualAmount: string | null;
      readonly dueDate: string | null | undefined;
      readonly lifeAreaId: string | null | undefined;
    },
  ): Promise<Task>;

  /** 软删：置 `deleted_at`。行不存在 / 已删 / 非本人返回 `false`。 */
  softDelete(userId: string, taskId: string): Promise<boolean>;

  /**
   * 批量操作（`POST /tasks/batch`）的核心：**单事务**内逐条校验归属与流转，
   * 任一条不合法则抛错回滚（整批失败、不产生部分写入）。
   */
  batchApply(
    userId: string,
    taskIds: readonly string[],
    operation: 'archive' | 'schedule',
    options: { readonly dueDate: string | null; readonly lifeAreaId: string | null },
  ): Promise<readonly Task[]>;

  /**
   * 「转为目标行动」的任务侧回填（GOAL-002）：同事务设置 `goalId` / `actionId`
   * 并把状态从 `inbox` 置为 `planned`。任务不是收件箱态时抛 `ValidationError`
   * （convert 的前置条件），找不到行抛 `NotFoundError`。
   */
  attachAction(
    userId: string,
    taskId: string,
    links: { readonly goalId: string; readonly actionId: string },
  ): Promise<Task>;
}
