/**
 * AI 草稿仓储端口（AI-003）。
 *
 * ## 为什么只有「写入」一个方法
 *
 * AI-003 只需要把端口与表立起来。草稿的确认、取消、过期清扫与列表读取都由
 * AI-004~006 的用例驱动（《详细设计说明书》§4.5 第 7~8 步）——现在就把那些方法
 * 写上，等于为还没定型的输入形状做设计，写了也要改。**端口按需生长**，
 * 每一次新增方法都应当由一个具体用例逼出来。
 */
import type { AiDraft, NewAiDraft } from './ai-draft.ts';

export interface AiDraftRepository {
  /**
   * 写入一条草稿。
   *
   * @returns 落库后的完整草稿（含服务端生成的 id 与时间戳）。
   */
  create(input: NewAiDraft): Promise<AiDraft>;
}
