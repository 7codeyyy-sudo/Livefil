/**
 * AI 用量仓储的 Drizzle 实现（AI-003，DB §4.13.2）。
 *
 * ## 聚合只认 `status='success'`
 *
 * mock 行（`skipped`）与失败行都不消耗真实额度。这条口径落在 SQL 的 `where` 里而不是
 * 应用层的过滤里：额度预检与 `GET /ai/usage` 的展示必须读**同一个**聚合，
 * 一旦某处漏掉状态过滤，就会出现「预检说没用满、展示说用满了」这类无法解释的差异。
 *
 * ## 为什么不加唯一约束 / 物化
 *
 * 量级小（每用户每月最多几百行），直查 count/sum 足够；`(user_id, created_at)`
 * 索引支撑窗口扫描（§4.13.2）。
 */
import { and, eq, gte, lte, sql } from 'drizzle-orm';

import type { Database } from '@/infrastructure/database/client.ts';
import { aiUsage } from '@/infrastructure/database/schema.ts';

import type { AiUsageSummary, NewAiUsageRecord } from '../domain/ai-usage.ts';
import type { AiUsageRepository } from '../domain/ai-usage-repository.ts';

/**
 * 创建 AI 用量仓储。
 *
 * @param db Drizzle 句柄（由组合根注入）。
 */
export function createAiUsageRepository(db: Database): AiUsageRepository {
  return {
    async record(input: NewAiUsageRecord): Promise<void> {
      await db.insert(aiUsage).values({
        userId: input.userId,
        provider: input.provider,
        model: input.model,
        requestType: input.requestType,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        estimatedCostMinor: input.estimatedCostMinor,
        status: input.status,
      });
    },

    async summarize(userId: string, from: Date, to: Date): Promise<AiUsageSummary> {
      const rows = await db
        .select({
          callCount: sql<number>`count(*)::int`,
          costMinor: sql<number>`coalesce(sum(${aiUsage.estimatedCostMinor}), 0)::int`,
        })
        .from(aiUsage)
        .where(
          and(
            eq(aiUsage.userId, userId),
            eq(aiUsage.status, 'success'),
            gte(aiUsage.createdAt, from),
            lte(aiUsage.createdAt, to),
          ),
        );

      // 聚合查询恒返回一行（无匹配时 count 为 0）；取不到只可能是驱动异常，按 0 处理
      // 会让「额度永远用不完」，因此这里显式给出兜底值并保持与 SQL 语义一致。
      const row = rows[0];
      return { callCount: row?.callCount ?? 0, costMinor: row?.costMinor ?? 0 };
    },
  };
}
