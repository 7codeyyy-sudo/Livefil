/**
 * 设置页的草稿模型与纯函数（IAM-002，《UI 页面规范》v0.16 §5）。
 *
 * ## 为什么单独一个文件
 *
 * 「草稿 → 补丁 → 服务端规范化后的值」这条链上全是纯函数。把它们从组件里拆出来
 * 有两个直接收益：组件只表达布局与交互，而这些规则（空数字输入的语义、脏判据、
 * 保存后如何合并回草稿）可以在 jsdom 之外被独立验证——它们的失败方式都是
 * "界面看起来对、数据其实错了"，恰恰是端到端测试最难断言的一类。
 *
 * ## 时间为什么只需要单向换算
 *
 * 服务端契约（《接口文档》§PATCH /me）接受 `HH:MM` 或 `HH:MM:SS`，所以**提交时
 * 直接用 `<input type="time">` 的 `HH:MM` 即可**，不必补秒。但响应里回来的是
 * `time` 列的字符串形态 `HH:MM:SS`，输入框只认 `HH:MM`，所以**读取方向必须换算**。
 * 只做单向换算是有意的：多一处无意义的转换就多一个"某处忘了补秒"的机会。
 */
import type { UserDto } from '@/modules/identity/application/user-dto.ts';

/** 设置页的草稿字段（可编辑的那部分）。字段名与接口契约一一对应。 */
export interface SettingsDraft {
  readonly locale: string;
  readonly timezone: string;
  readonly currencyCode: string;
  readonly weekStartsOn: number;
  readonly defaultTaskDurationMinutes: number | null;
  readonly defaultBufferMinutes: number | null;
  readonly reminderEnabled: boolean;
  /** `HH:MM`（`<input type="time">` 的形态）；`null` 表示不设安静时段。 */
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
  readonly aiEnabled: boolean;
  readonly aiDataConsent: boolean;
}

/**
 * 全部可编辑字段。
 *
 * 显式列出而不是用 `Object.keys(draft)`：脏判据要跳过"不是可编辑字段"的项
 * （将来若有只读展示字段，`Object.keys` 会把它一并算进去，于是页面永远显示"未保存"）。
 */
export const SETTINGS_FIELDS = [
  'locale',
  'timezone',
  'currencyCode',
  'weekStartsOn',
  'defaultTaskDurationMinutes',
  'defaultBufferMinutes',
  'reminderEnabled',
  'quietHoursStart',
  'quietHoursEnd',
  'aiEnabled',
  'aiDataConsent',
] as const satisfies readonly (keyof SettingsDraft)[];

/** 从接口响应建立草稿。 */
export function toDraft(dto: UserDto): SettingsDraft {
  return {
    locale: dto.locale,
    timezone: dto.timezone,
    currencyCode: dto.currencyCode,
    weekStartsOn: dto.weekStartsOn,
    defaultTaskDurationMinutes: dto.defaultTaskDurationMinutes,
    defaultBufferMinutes: dto.defaultBufferMinutes,
    reminderEnabled: dto.reminderEnabled,
    quietHoursStart: toInputTime(dto.quietHoursStart),
    quietHoursEnd: toInputTime(dto.quietHoursEnd),
    aiEnabled: dto.aiEnabled,
    aiDataConsent: dto.aiDataConsent,
  };
}

/** `HH:MM:SS` → `HH:MM`（服务端形态 → 输入框形态）。 */
export function toInputTime(value: string | null): string | null {
  return value === null ? null : value.slice(0, 5);
}

/**
 * 文本输入 → 可空整数。
 *
 * 空字符串表示"不设默认值"（`null`），而不是 0：0 分钟时长与"没确认过自己的
 * 习惯"是两件事，用 0 代替缺省会让"清空默认时长"变成"默认时长为零"。
 *
 * @returns 合法整数、或 `null`（空输入）；非法输入也返回 `null`，由服务端的
 *   范围校验兜住——客户端不做半套校验，那只会让两套规则漂移。
 */
export function toNullableInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** 空数字输入的显示值（`null` → 空串，而不是 `"null"`）。 */
export function toNumberInput(value: number | null): string {
  return value === null ? '' : String(value);
}

/** 某一组字段是否与基线不同。 */
export function isSectionDirty<K extends keyof SettingsDraft>(
  draft: SettingsDraft,
  baseline: SettingsDraft,
  keys: readonly K[],
): boolean {
  return keys.some((key) => draft[key] !== baseline[key]);
}

/** 是否存在任何未保存的修改（路由离开守卫用它）。 */
export function isAnyDirty(draft: SettingsDraft, baseline: SettingsDraft): boolean {
  return isSectionDirty(draft, baseline, SETTINGS_FIELDS);
}

/**
 * 设置分区共用的 props。
 *
 * 每个分区拿到的是**整份草稿 + 自己关心的键**，而不是"自己那一片值"：分区的
 * 脏判据、提交子集、保存后合并都只依赖 draft / baseline 这两个对象与一组键，
 * 各分区因此不需要各自再声明一遍这些逻辑。
 */
export interface SectionBindings {
  readonly draft: SettingsDraft;
  readonly baseline: SettingsDraft;
  /** 更新草稿中的若干字段。 */
  readonly update: (patch: Partial<SettingsDraft>) => void;
  /** 保存指定的字段子集（失败时抛出，由调用方转成界面文案）。 */
  readonly save: (keys: readonly (keyof SettingsDraft)[]) => Promise<void>;
}

/**
 * 取出一次保存要提交的字段子集。
 *
 * 只提交**本分区**的字段而不是整份草稿：整份提交会让"我在任务默认值里改了数字、
 * 顺手在提醒里动了一下开关但还没按保存"变成一次隐式保存——用户没有同意过那个
 * 改动，界面上的"未保存"标记却消失了。
 */
export function toProfilePatch<K extends keyof SettingsDraft>(
  draft: SettingsDraft,
  keys: readonly K[],
): Pick<SettingsDraft, K> {
  // 循环填充无法让 TS 证明"每个键都被赋过值"，所以这里有一次断言。
  // 它只影响类型，不影响运行时；`keys` 的元素类型仍受 `K` 约束。
  const patch = {} as Mutable<Pick<SettingsDraft, K>>;
  for (const key of keys) {
    patch[key] = draft[key];
  }
  return patch;
}

/**
 * 保存成功后，只把**本次提交的字段**用服务端的值覆盖。
 *
 * 关键在"只"字：若整份草稿都用响应重建，用户在另一个分区里没来得及保存的编辑
 * 会被静默丢掉——那种丢失最难察觉，因为界面看起来"保存成功了"。
 */
export function adoptSaved<K extends keyof SettingsDraft>(
  current: SettingsDraft,
  savedKeys: readonly K[],
  fresh: SettingsDraft,
): SettingsDraft {
  const next: Mutable<SettingsDraft> = { ...current };
  for (const key of savedKeys) {
    next[key] = fresh[key];
  }
  return next;
}

/** 去掉只读修饰的同一类型（仅用于"构造一份局部改写的副本"）。 */
type Mutable<T> = { -readonly [P in keyof T]: T[P] };
