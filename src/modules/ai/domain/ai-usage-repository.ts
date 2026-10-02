/**
 * AI 用量仓储端口（AI-003，DB §4.13.2）。
 *
 * 只声明 AI-003 真正会用到的两项：入账与按时间窗聚合。`GET /ai/usage` 的
 * 「剩余额度」由「上限 − 聚合值」算出，因此聚合这一项同时服务额度预检与额度展示，
 * 不需要两个方法。
 */
import type { AiUsageSummary, NewAiUsageRecord } from './ai-usage.ts';

export interface AiUsageRepository {
  /** 写入一行追加式账本（只写不改）。 */
  record(input: NewAiUsageRecord): Promise<void>;

  /**
   * 聚合 `[from, to]`（闭区间）内该用户的已用次数与成本。
   *
   * **只统计 `status='success'`**（DB §4.13.2）：mock 行（`skipped`）与失败行
   * 都不消耗真实额度。区间取闭是为了让固定时钟的测试里「同一时刻入账又预检」
   * 也能被算进来。
   *
   * @param from 窗口起点（含）。
   * @param to 窗口终点（含）。
   */
  summarize(userId: string, from: Date, to: Date): Promise<AiUsageSummary>;
}
