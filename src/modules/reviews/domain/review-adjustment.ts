/**
 * 复盘调整（REVIEW-003，DB §4.11.4、SRS FR-062、UI 规范 B3/B4）。
 *
 * ## 追加式
 *
 * 「清单只增不删、本页不提供撤销」——修正靠再次执行动作追加新记录，而不是改旧行。
 * 因此本实体没有 `version`，也没有删除路径（DB §4.11.4）。
 *
 * ## 「记录 + 执行（同一事务）」
 *
 * 预审裁定第 6 项：写入一行 `review_adjustments` 的同时对 target 施加对应变更，
 * 二者同事务成功或失败。**动作语义 → 写入意图**的映射是纯规则，落在本文件的
 * `adjustmentWriteOf()`；真正落盘（含事务与乐观并发）由基础设施端口完成。
 *
 * ## `keep` 的两类 target
 *
 * DB §4.11.4 的动作表把 `keep` 写为 `task` 行，但 UI 规范 B3 目标类洞察的动作集是
 * 「保留 / 暂停目标」——若 `keep` 只认 task，目标类「保留」将必然 422。故按
 * **B3（形态唯一准据）**放开 `keep` 到 `task` 与 `goal` 两类，其余四项与动作表一致。
 */
import { ValidationError } from '@/shared/errors/app-error.ts';

/** 五动作（DB §4.11.4）。「调整提醒频率」顺延 Phase 8，不在此列。 */
export const REVIEW_ADJUSTMENT_ACTIONS = ['keep', 'shorten', 'defer', 'pause', 'delete'] as const;

export type AdjustmentAction = (typeof REVIEW_ADJUSTMENT_ACTIONS)[number];

/** 调整对象类型。 */
export const REVIEW_ADJUSTMENT_TARGET_TYPES = ['task', 'goal'] as const;

export type AdjustmentTargetType = (typeof REVIEW_ADJUSTMENT_TARGET_TYPES)[number];

/**
 * 动作 × 对象类型 的合法组合（DB §4.11.4 的动作表 + B3 对 `keep` 的放开）。
 *
 * 用数组而不是单值：`keep` 是唯一可用于两类对象的动作。
 */
export const ALLOWED_TARGET_TYPES: Readonly<
  Record<AdjustmentAction, readonly AdjustmentTargetType[]>
> = {
  keep: ['task', 'goal'],
  shorten: ['task'],
  defer: ['task'],
  pause: ['goal'],
  delete: ['task'],
};

/** `shorten` 的参数：缩短到的预计时长（分钟）。 */
export interface ShortenAdjustmentPayload {
  readonly estimatedMinutes: number;
}

/** `defer` 的参数：移到的新日期。 */
export interface DeferAdjustmentPayload {
  readonly dueDate: string;
}

/** `keep` / `pause` / `delete` 无参数（`{}`）。 */
export type EmptyAdjustmentPayload = Record<string, never>;

export type AdjustmentPayload =
  ShortenAdjustmentPayload | DeferAdjustmentPayload | EmptyAdjustmentPayload;

/** 调整记录实体（追加式，无 `version`）。 */
export interface ReviewAdjustment {
  readonly id: string;
  readonly userId: string;
  readonly reviewId: string;
  readonly targetType: AdjustmentTargetType;
  readonly targetId: string;
  readonly action: AdjustmentAction;
  readonly payload: AdjustmentPayload;
  readonly createdAt: string;
}

/** 新增调整的输入（`reviewId` 由用例解析得出，不由客户端给）。 */
export interface ReviewAdjustmentCreateInput {
  readonly reviewId: string;
  readonly targetType: AdjustmentTargetType;
  readonly targetId: string;
  readonly action: AdjustmentAction;
  readonly payload: AdjustmentPayload;
}

/**
 * 调整要施加的**写入意图**。
 *
 * 领域层只表达「改什么」，不表达「怎么改」——落盘（事务、乐观并发、软删）属于
 * 基础设施；这样新增一个动作时不必把 SQL 也改一遍。
 */
export type AdjustmentWrite =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'task';
      readonly taskId: string;
      readonly estimatedMinutes?: number | undefined;
      readonly dueDate?: string | undefined;
      readonly softDelete?: true | undefined;
    }
  | { readonly kind: 'goal'; readonly goalId: string; readonly status: 'paused' };

/** 动作与对象类型是否匹配（不匹配 → 422，接口 §10）。 */
export function isAllowedCombination(
  action: AdjustmentAction,
  targetType: AdjustmentTargetType,
): boolean {
  return ALLOWED_TARGET_TYPES[action].includes(targetType);
}

/**
 * 动作 → 写入意图（纯函数）。
 *
 * `keep` 是**显式无写入**（而不是"没有这个动作"）：它仍要落一条调整记录，这样
 * 「我确认过这条任务，不改」在清单里查得到——可追溯的对象是**决定**，不是改动。
 *
 * @throws {ValidationError} 动作与对象类型不匹配，或 `payload` 与动作不符时抛出。
 */
export function adjustmentWriteOf(
  action: AdjustmentAction,
  payload: AdjustmentPayload,
  targetId: string,
): AdjustmentWrite {
  if (action === 'keep') {
    return { kind: 'none' };
  }

  if (action === 'pause') {
    return { kind: 'goal', goalId: targetId, status: 'paused' };
  }

  if (action === 'shorten') {
    const estimatedMinutes = 'estimatedMinutes' in payload ? payload.estimatedMinutes : undefined;
    if (typeof estimatedMinutes !== 'number') {
      throw new ValidationError('缩短动作必须提供 estimatedMinutes');
    }
    return { kind: 'task', taskId: targetId, estimatedMinutes };
  }

  if (action === 'defer') {
    const dueDate = 'dueDate' in payload ? payload.dueDate : undefined;
    if (typeof dueDate !== 'string') {
      throw new ValidationError('延期动作必须提供 dueDate');
    }
    return { kind: 'task', taskId: targetId, dueDate };
  }

  return { kind: 'task', taskId: targetId, softDelete: true };
}

/** 回读判定：不在契约集合内的取值由仓储抛领域错误。 */
export function isAdjustmentAction(value: string): value is AdjustmentAction {
  return (REVIEW_ADJUSTMENT_ACTIONS as readonly string[]).includes(value);
}

export function isAdjustmentTargetType(value: string): value is AdjustmentTargetType {
  return (REVIEW_ADJUSTMENT_TARGET_TYPES as readonly string[]).includes(value);
}
