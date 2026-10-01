/**
 * AI 草稿仓储的 Drizzle 实现（AI-003，DB §4.13.1）。
 *
 * 只有「写入」一条路径：AI-003 的交付边界是「把端口与表立起来」，确认 / 取消 /
 * 过期清扫由 AI-004~006 的用例驱动再补（见领域端口文件的说明）。
 *
 * 枚举列在**读出时**二次校验：数据库的 CHECK 只挡住 `draft_type`，`status` 与
 * `error_code` 没有 `IN` 约束，绕过应用写库的脏值必须在边界处现形，
 * 而不是被默默地透传给用例。
 */
import type { Database } from '@/infrastructure/database/client.ts';
import { aiDrafts, type AiDraftRow } from '@/infrastructure/database/schema.ts';
import { InvariantError } from '@/shared/errors/app-error.ts';

import {
  isAiDraftErrorCode,
  isAiDraftStatus,
  isAiDraftType,
  type AiDraft,
  type NewAiDraft,
} from '../domain/ai-draft.ts';
import type { AiDraftRepository } from '../domain/ai-draft-repository.ts';

/** 行 → 领域实体。枚举列若被绕过应用写库，明确报错而不是把脏值传给上层。 */
function toAiDraft(row: AiDraftRow): AiDraft {
  if (!isAiDraftType(row.draftType)) {
    throw new InvariantError({ message: 'ai_drafts.draft_type 不在契约集合内' });
  }
  if (!isAiDraftStatus(row.status)) {
    throw new InvariantError({ message: 'ai_drafts.status 不在契约集合内' });
  }
  if (row.errorCode !== null && !isAiDraftErrorCode(row.errorCode)) {
    throw new InvariantError({ message: 'ai_drafts.error_code 不在契约集合内' });
  }
  return {
    id: row.id,
    userId: row.userId,
    draftType: row.draftType,
    inputHash: row.inputHash,
    sanitizedInput: row.sanitizedInput,
    resultJson: row.resultJson,
    status: row.status,
    provider: row.provider,
    model: row.model,
    expiresAt: row.expiresAt.toISOString(),
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 创建 AI 草稿仓储。
 *
 * @param db Drizzle 句柄（由组合根注入）。
 */
export function createAiDraftRepository(db: Database): AiDraftRepository {
  return {
    async create(input: NewAiDraft): Promise<AiDraft> {
      const rows = await db
        .insert(aiDrafts)
        .values({
          userId: input.userId,
          draftType: input.draftType,
          inputHash: input.inputHash,
          sanitizedInput: input.sanitizedInput,
          resultJson: input.resultJson,
          status: input.status,
          provider: input.provider,
          model: input.model,
          expiresAt: input.expiresAt,
          errorCode: input.errorCode,
        })
        .returning();

      const row = rows[0];
      if (row === undefined) {
        throw new InvariantError({ message: '写入 AI 草稿后数据库未返回记录' });
      }
      return toAiDraft(row);
    },
  };
}
