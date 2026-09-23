/**
 * 冲突检测（SCHED-002，接口 §6 冻结口径）。
 *
 * 半开区间 `[starts, ends)`——**重叠才冲突、相邻不撞**；跨时区一律换算 UTC
 * 后比较。检测对象：未取消的 `schedule_blocks` + 当日 `fixed_commitments`
 * 实例。可解释性：每个冲突带 `kind` 与自己的时间窗。
 */
import type { ScheduleBlock } from './schedule-block.ts';
import type { FixedCommitment } from './schedule-block.ts';

/** 冲突元素的对外形态（接口 §6 的 `conflicts[]`）。 */
export interface ConflictItem {
  readonly id: string;
  readonly kind: 'block' | 'fixed';
  readonly startsAtUtc: string;
  readonly endsAtUtc: string;
  readonly title: string | null;
}

/** 半开区间重叠判定：`a.s < b.e && b.s < a.e`。相邻（a.e == b.s）不算。 */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * 计算一个候选时间窗与既有块的冲突。
 *
 * @param excludeBlockId PATCH 场景排除自身（移动自己不构成与自己的冲突）。
 */
export function detectBlockConflicts(
  candidate: { readonly startsAtUtc: Date; readonly endsAtUtc: Date },
  blocks: readonly ScheduleBlock[],
  excludeBlockId?: string,
): readonly ConflictItem[] {
  const start = candidate.startsAtUtc.getTime();
  const end = candidate.endsAtUtc.getTime();
  return blocks
    .filter(
      (block) =>
        block.status !== 'cancelled' &&
        block.id !== excludeBlockId &&
        overlaps(start, end, block.startsAtUtc.getTime(), block.endsAtUtc.getTime()),
    )
    .map((block) => ({
      id: block.id,
      kind: 'block' as const,
      startsAtUtc: block.startsAtUtc.toISOString(),
      endsAtUtc: block.endsAtUtc.toISOString(),
      title: null,
    }));
}

/** 候选时间窗与固定事项实例的冲突。 */
export function detectFixedConflicts(
  candidate: { readonly startsAtUtc: Date; readonly endsAtUtc: Date },
  fixed: readonly FixedCommitment[],
): readonly ConflictItem[] {
  const start = candidate.startsAtUtc.getTime();
  const end = candidate.endsAtUtc.getTime();
  return fixed
    .filter((item) =>
      overlaps(
        start,
        end,
        item.startsAtUtc?.getTime() ?? Number.NaN,
        item.endsAtUtc?.getTime() ?? Number.NaN,
      ),
    )
    .map((item) => ({
      id: item.id,
      kind: 'fixed' as const,
      startsAtUtc: (item.startsAtUtc as Date).toISOString(),
      endsAtUtc: (item.endsAtUtc as Date).toISOString(),
      title: item.title,
    }));
}

/** 合并块与固定事项的冲突并按开始时间排序（可解释列表的统一出口）。 */
export function mergeConflicts(
  ...groups: readonly (readonly ConflictItem[])[]
): readonly ConflictItem[] {
  return groups.flat().sort((a, b) => a.startsAtUtc.localeCompare(b.startsAtUtc));
}
