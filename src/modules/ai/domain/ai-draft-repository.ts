/**
 * AI 草稿仓储端口（AI-003；AI-004~006 按需生长）。
 *
 * ## 端口按需生长
 *
 * AI-003 只立了「写入」；确认 / 取消由 AI-004~006 的用例逼出，于是这里补齐
 * 读取与**条件状态迁移**两项——每新增一个方法都对应着一个具体用例的真实需要。
 *
 * ## 为什么状态迁移是「条件更新」而不是「先读后写」
 *
 * 确认是「一次性消费」：同一个草稿被并发确认两次，只能有一次真正写入业务实体。
 * 若做成「读状态 → 判断 → 写状态」，两次请求都会读到 `pending`，随后都写入。
 * 条件更新（`WHERE status = from`）把判定与写入合成一条原子语句，并发时只有
 * 一条命中，另一条拿到 `null` 由用例转成 409。
 */
import type { AiDraft, AiDraftStatus, NewAiDraft } from './ai-draft.ts';

export interface AiDraftRepository {
  /**
   * 写入一条草稿。
   *
   * @returns 落库后的完整草稿（含服务端生成的 id 与时间戳）。
   */
  create(input: NewAiDraft): Promise<AiDraft>;

  /**
   * 按 id 读取草稿，**限定当前用户**（非本人与不存在同义，一律 `null`）。
   *
   * @param userId 当前用户。
   * @param draftId 草稿 id。
   */
  findById(userId: string, draftId: string): Promise<AiDraft | null>;

  /**
   * 条件状态迁移：仅当草稿当前状态等于 `from` 时才更新为 `to`。
   *
   * @returns 迁移后的草稿；行不存在、非本人或状态已不等于 `from` 时为 `null`。
   */
  transitionStatus(
    userId: string,
    draftId: string,
    from: AiDraftStatus,
    to: AiDraftStatus,
  ): Promise<AiDraft | null>;
}
