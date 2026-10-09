/**
 * data-management 的表现层视图函数（OPS-002；《详细设计》§4.3 + 依赖规则
 * 「表现层不得越过应用层访问领域与基础设施」）。
 *
 * 纯函数、零依赖：设置页分区 7 的计数表、合并摘要与类型标签从这里取，
 * 组件不自己拼字符串——契约字段（`total`/`新增`/`重复`）到中文列名的
 * 映射只存在这一处。
 *
 * 类型在这里**本地同形声明**而不 import 领域层（规则禁跨层引用）：结构与
 * domain 的 `ImportTypeCount` / `RecycleEntityType` 一致，消费点靠结构赋值
 * 对接——这正是分层规则期望的「上层只认形状」。
 */

/** 计数对象（与 `domain/data-ports.ts` 的 `ImportTypeCount` 同形）。 */
export interface Countable {
  readonly total: number;
  readonly 新增: number;
  readonly 重复: number;
}

/** 计数表的行键（与导出文件顶层键同名 + settings）。 */
export type CountKey =
  'tasks' | 'goals' | 'executionLogs' | 'routines' | 'expenses' | 'reviews' | 'settings';

/** 回收区类型（与 `RecycleEntityType` 同形的字面联合）。 */
export type RecycleKind = 'task' | 'action' | 'routine' | 'fixed_commitment' | 'expense';

/** 计数表的行（预览态分类型计数表直接渲染）。 */
export interface CountRow {
  readonly key: CountKey;
  readonly label: string;
  readonly counts: Countable;
}

const TYPE_LABELS: Readonly<Record<CountKey, string>> = Object.freeze({
  tasks: '任务',
  goals: '目标',
  executionLogs: '执行记录',
  routines: '例程',
  expenses: '开销',
  reviews: '复盘',
  settings: '设置',
});

/** 回收区行的类型标签（跨类型列表的「类型」列）。 */
const RECYCLE_LABELS: Readonly<Record<RecycleKind, string>> = Object.freeze({
  task: '任务',
  action: '行动',
  routine: '例程',
  fixed_commitment: '固定事项',
  expense: '开销',
});

/** 回收区类型 → 展示标签。 */
export function recycleTypeLabel(entityType: RecycleKind): string {
  return RECYCLE_LABELS[entityType];
}

/** 预览计数 → 计数表行（顺序＝契约导出范围顺序，设置殿后）。 */
export function countRows(counts: Readonly<Record<CountKey, Countable>>): readonly CountRow[] {
  return (Object.keys(TYPE_LABELS) as readonly CountKey[]).map((key) => ({
    key,
    label: TYPE_LABELS[key],
    counts: counts[key] ?? { total: 0, 新增: 0, 重复: 0 },
  }));
}

/**
 * 合并视角摘要（UI 冻结句「将新增 N 条 / 跳过重复 M 条」的两个数）。
 *
 * 设置行不计入摘要：merge 下设置恒重复（singleton），把「1 条设置」并进
 * 「跳过重复」会让用户以为自己的任务被跳过了一条——摘要只汇总实体类型。
 */
export function mergeSummary(counts: Readonly<Record<CountKey, Countable>>): {
  readonly added: number;
  readonly repeated: number;
} {
  let added = 0;
  let repeated = 0;
  for (const key of [
    'tasks',
    'goals',
    'executionLogs',
    'routines',
    'expenses',
    'reviews',
  ] as const) {
    added += counts[key]?.新增 ?? 0;
    repeated += counts[key]?.重复 ?? 0;
  }
  return { added, repeated };
}
