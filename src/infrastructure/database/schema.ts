/**
 * schema 的模块内入口（DB-001）。
 *
 * 真正的表定义在项目根的 `drizzle/schema.ts`——那是《详细设计说明书》§2 目录契约
 * 与 §11 迁移策略指定的位置（schema 必须与迁移产物同目录，`drizzle-kit` 才能
 * 把二者对应起来）。
 *
 * 这里只做一次 re-export，理由是**相对路径只出现一次**：`src/` 到项目根要退
 * 若干层，模块越深层数越多（仓储实现在 `src/modules/<模块>/infrastructure/`），
 * 逐个文件手写 `../../../../drizzle/schema` 迟早会有一个写错——而写错的表现是
 * 编译期报"找不到模块"，排查成本远高于在这里多一层间接。
 *
 * 只导出表与行类型；不导出 `drizzle-kit` 的任何东西（它是构建期工具，
 * 不该出现在应用运行时的依赖图里）。
 */
export {
  actions,
  goals,
  idempotencyKeys,
  lifeAreas,
  tasks,
  users,
} from '../../../drizzle/schema.ts';
export type {
  ActionRow,
  GoalRow,
  IdempotencyKeyRow,
  LifeAreaRow,
  NewActionRow,
  NewGoalRow,
  NewIdempotencyKeyRow,
  NewLifeAreaRow,
  NewTaskRow,
  NewUserRow,
  TaskRow,
  UserRow,
} from '../../../drizzle/schema.ts';
