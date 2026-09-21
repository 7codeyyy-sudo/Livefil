/**
 * 生活领域（DB-001 / IAM-003，《数据库设计文档》§4.2、《详细设计说明书》§4.8）。
 */
import { ValidationError } from '@/shared/errors/app-error.ts';

/**
 * 分类色 key 的合法集合。
 *
 * **契约**：与《UI 页面规范》§2.1 的「分类色族」六枚令牌一一对应
 * （`--color-cat-blue` 等），增减必须经规范升版。领域只存 key、不存色值——
 * 色值属于设计系统，把它写进数据行会把"改配色"变成一次数据迁移。
 *
 * 分类色与状态语义色是**两族**：success/danger 表达"好/坏"，分类色表达
 * "属于哪一类"。所以领域名叫「健康」也不会用到 danger 的红——否则一个分类
 * 标记会被读成一次错误（§2.1 的论证）。
 */
export const LIFE_AREA_COLOR_KEYS = ['blue', 'green', 'amber', 'violet', 'teal', 'rose'] as const;

export type LifeAreaColorKey = (typeof LIFE_AREA_COLOR_KEYS)[number];

/** 名称长度上限（§4.2 的 `varchar(60)`）。 */
export const LIFE_AREA_NAME_MAX_LENGTH = 60;

/** 领域实体。 */
export interface LifeArea {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly colorKey: LifeAreaColorKey;
  readonly sortOrder: number;
  /** 是否由首启播种写入（用户可改名、可归档，此标记仅作来源记录）。 */
  readonly isDefault: boolean;
  readonly isArchived: boolean;
  readonly version: number;
}

/** 播种一个领域所需的最小信息。 */
export interface LifeAreaSeed {
  readonly name: string;
  readonly colorKey: LifeAreaColorKey;
  readonly sortOrder: number;
}

/** 创建领域的输入（已通过校验）。 */
export interface LifeAreaCreateInput {
  readonly name: string;
  readonly colorKey: LifeAreaColorKey;
}

/**
 * 更新领域的补丁：键存在即"要改这一项"。
 *
 * 值类型显式带 `| undefined`：项目启用了 `exactOptionalPropertyTypes`，
 * 而校验层（Zod）产出的可选字段天然含 `undefined`。详见
 * `identity/domain/user.ts` 里 `UserSettingsPatch` 的同一条说明。
 */
export interface LifeAreaPatch {
  readonly name?: string | undefined;
  readonly colorKey?: LifeAreaColorKey | undefined;
  readonly isArchived?: boolean | undefined;
}

/** 判断任意字符串是否为合法的分类色 key（用于运行时校验的收口）。 */
export function isLifeAreaColorKey(value: string): value is LifeAreaColorKey {
  return (LIFE_AREA_COLOR_KEYS as readonly string[]).includes(value);
}

/**
 * 校验"重排请求恰好覆盖当前未归档领域集合"。
 *
 * 放在领域层而不是仓储实现里：它是**业务规则**（§4.8「列表必须恰好等于该用户
 * 当前未归档领域集合，多/少/他人 id → `VALIDATION_ERROR`」），仓储只该负责
 * 在事务内按序写回。实现侧调用本函数，规则因此只有一个定义处。
 *
 * 为什么要求"恰好相等"而不是"给出顺序、其余不动"：后者会让一次部分提交
 * 产生重复的 `sort_order`（未列出的项保持原值，可能与新值撞车），而
 * `sort_order` 是排序的唯一依据，重复序号意味着顺序不确定。
 *
 * @param activeIds 当前未归档领域的 id（顺序无关）。
 * @param orderedIds 请求给的顺序。
 * @throws {ValidationError} 集合不一致时抛出。
 */
export function assertReorderCoversActiveSet(
  activeIds: readonly string[],
  orderedIds: readonly string[],
): void {
  const active = new Set(activeIds);
  const ordered = new Set(orderedIds);

  if (orderedIds.length !== ordered.size) {
    throw new ValidationError('排序列表中存在重复的领域 id');
  }

  const missing = [...active].filter((id) => !ordered.has(id));
  const unknown = [...ordered].filter((id) => !active.has(id));

  if (missing.length > 0 || unknown.length > 0) {
    throw new ValidationError('排序列表必须恰好包含当前全部未归档领域', {
      details: { missingCount: missing.length, unknownCount: unknown.length },
    });
  }
}
