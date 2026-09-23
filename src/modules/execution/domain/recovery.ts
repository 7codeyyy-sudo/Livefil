/**
 * 恢复模式规则（EXEC-002，接口 §7 冻结口径；规则落 domain 层、非前端文案）。
 *
 * 全部是**纯函数**：/today 聚合查完数据后在这里算，便于单测与将来调口径。
 * 文案中性：不做归零、惩罚、streak 清零（SRS FR-042 红线）。
 */
import type { ExecutionStatus } from './execution-log.ts';

/** 单日完成情况（由聚合层按用户时区切日后汇总）。 */
export interface DayCompletion {
  readonly date: string;
  /** 当日未取消块时长合计（分钟）。 */
  readonly plannedMinutes: number;
  /** 当日 completed/minimum_completed 记录的 actual（缺省 planned）分钟合计。 */
  readonly completedMinutes: number;
}

/** 完成率；无计划日不参与统计。 */
export function completionRate(day: DayCompletion): number | null {
  if (day.plannedMinutes <= 0) {
    return null;
  }
  return day.completedMinutes / day.plannedMinutes;
}

/**
 * 自动提示判定：回看最近 7 个**有计划任务的日子**，若最近的 2 个连续
 * 有计划日完成率都 < 50%，触发轻量提示（可忽略、不自动改计划）。
 * 冻结文本的"其中连续 2 天"取最保守解读——必须是最靠前的两天都低才触发。
 */
export function detectAutoTrigger(days: readonly DayCompletion[]): boolean {
  const planned = [...days]
    .filter((day) => day.plannedMinutes > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-7);
  if (planned.length < 2) {
    return false;
  }
  const last = planned[planned.length - 1];
  const previous = planned[planned.length - 2];
  const rateOf = (day: DayCompletion | undefined): number =>
    day === undefined ? 1 : (completionRate(day) ?? 1);
  return rateOf(last) < 0.5 && rateOf(previous) < 0.5;
}

/** 恢复建议（手动恢复态下对今日未完成块生成；顺序＝冻结顺序）。 */
export type SuggestionCode = 'SHRINK' | 'MINIMUM' | 'RESCHEDULE' | 'PAUSE';

export interface RecoverySuggestion {
  readonly code: SuggestionCode;
  /** 目标块/任务 id；PAUSE 是全局建议无目标。 */
  readonly target: string | null;
  readonly text: string;
}

export interface SuggestionBlock {
  readonly id: string;
  readonly title: string;
  readonly status: 'planned' | 'active' | 'completed' | 'adjusted' | 'cancelled';
  readonly endsAtUtc: Date;
  readonly durationMinutes: number;
  readonly taskId: string | null;
  readonly minimumVersion: string | null;
}

export interface SuggestionInput {
  readonly blocks: readonly SuggestionBlock[];
  readonly now: Date;
  readonly overloaded: boolean;
  /** 今日尚可安排的空档（已扣除固定事项与块；仅建议、不落库）。 */
  readonly freeSlots: readonly { readonly start: Date; readonly end: Date }[];
}

/** 按冻结顺序生成建议：SHRINK → MINIMUM → RESCHEDULE →（无空档）PAUSE。 */
export function buildRecoverySuggestions(input: SuggestionInput): readonly RecoverySuggestion[] {
  const suggestions: RecoverySuggestion[] = [];
  const unfinished = input.blocks.filter(
    (block) =>
      block.status === 'planned' || block.status === 'active' || block.status === 'adjusted',
  );

  if (input.overloaded && unfinished.length > 0) {
    // 可压缩＝计划时长最长的那个块（减量收益最大，解释也最直观）。
    const longest = [...unfinished].sort((a, b) => b.durationMinutes - a.durationMinutes)[0];
    if (longest !== undefined) {
      suggestions.push({
        code: 'SHRINK',
        target: longest.id,
        text: `「${longest.title}」今天排得偏满，可以先缩短来做`,
      });
    }
  }

  for (const block of unfinished) {
    if (block.minimumVersion !== null) {
      suggestions.push({
        code: 'MINIMUM',
        target: block.id,
        text: `「${block.title}」可以先做最低版本：${block.minimumVersion}`,
      });
      break;
    }
  }

  const overdue = unfinished.filter((block) => block.endsAtUtc.getTime() <= input.now.getTime());
  const firstOverdue = overdue[0];
  if (firstOverdue !== undefined) {
    const hasFreeSlot = input.freeSlots.length > 0;
    if (hasFreeSlot) {
      suggestions.push({
        code: 'RESCHEDULE',
        target: firstOverdue.id,
        text: `「${firstOverdue.title}」的时间已经过了，可以挪到今天还有空的时候`,
      });
    } else {
      suggestions.push({
        code: 'PAUSE',
        target: null,
        text: '今天剩下的时间不多了，把没完成的留给明天也可以',
      });
    }
  }

  return suggestions;
}

/** 完成口径（统计用）：completed 与 minimum_completed 都算"做到了"。 */
export function countsAsCompleted(status: ExecutionStatus): boolean {
  return status === 'completed' || status === 'minimum_completed';
}
