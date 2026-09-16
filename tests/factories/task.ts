/**
 * `tasks` 行工厂（FND-003）。
 *
 * 默认产出一个「收件箱任务」：与 TASK-002（收件箱快速添加只要求标题）的真实常态一致，
 * 三个归属外键均留空。需要归属生活领域、目标或行动时，由调用方显式传入对应 id。
 */
import type { FactoryContext, TaskRow, UserRow } from './types.ts';

/** 任务标题前缀，配合内部序号生成可读且互不相同的默认标题。 */
const DEFAULT_TITLE_PREFIX = '任务';

export type TaskFactory = (overrides?: Partial<TaskRow>) => TaskRow;

export interface TaskFactoryDependencies {
  /** 补齐非空公共字段 `user_id` 所需的用户工厂。 */
  readonly createUser: (overrides?: Partial<UserRow>) => UserRow;
}

/**
 * 创建任务工厂。
 *
 * @param context 共享随机源、ID 与时钟。
 * @param dependencies 补齐非空外键所需的依赖工厂。
 * @returns 任务工厂。
 */
export function createTaskFactory(
  context: FactoryContext,
  dependencies: TaskFactoryDependencies,
): TaskFactory {
  let sequence = 0;

  return (overrides = {}) => {
    sequence += 1;
    const timestamp = context.clock.isoNow();

    let userId = overrides.user_id;
    if (userId === undefined) {
      userId = dependencies.createUser().id;
    }

    const row: TaskRow = {
      id: context.ids.next(),
      user_id: userId,
      life_area_id: null,
      goal_id: null,
      action_id: null,
      title: `${DEFAULT_TITLE_PREFIX} ${sequence}`,
      status: 'inbox',
      estimated_minutes: null,
      minimum_version: null,
      due_date: null,
      recurrence_rule: null,
      source: 'manual',
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
      version: 1,
      ...overrides,
    };

    return Object.freeze(row);
  };
}
