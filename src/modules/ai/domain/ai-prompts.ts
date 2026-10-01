/**
 * AI 系统指令（AI-004/005/006，RD-20260929-006 §1.4、§1.7）。
 *
 * ## 为什么指令是常量而不是在用例里拼出来
 *
 * 指令里写死了「只输出 JSON」「禁止四类建议」这类**契约级约束**：它们正是
 * FR-083 与《接口文档》§11 判定 3 的实现落点（system prompt 约束 + 输出后校验
 * 双保险）。一旦散落在各用例中拼接，就无法回答「当前到底给模型下过哪些约束」，
 * 也无法保证新增一类调用时不会漏掉禁区约束。
 *
 * ## AI-006 的四类禁区（FR-083 / §11 判定 3）
 *
 * 「不提供投资、借贷、医疗或心理诊断建议」是 **AI-006（开销解析 + 复盘建议）**
 * 的验收项（`开发任务清单` §12）。本文件把该约束作为
 * {@link AI_PROHIBITED_ADVICE_CLAUSE} 明文写入 AI-006 两类调用的指令中。
 *
 * **光靠指令不够**：模型未必遵守，因此上层还有 `ai-advice-policy.ts` 的输出后
 * 关键字拦截作为第二道防线（§11 判定 3 要求「prompt 约束 + 输出后校验拦截 +
 * 测试点」三重保证）。
 */
import type { AiRequestType } from './ai-provider.ts';

/**
 * AI-006 的四类禁区约束（FR-083）。
 *
 * 逐字覆盖「投资、借贷、医疗或心理诊断」四项，并要求越界时只引导用户咨询
 * 专业人士、不给替代方案——「不给建议」与「给一个模糊的建议」在用户看来是两回事。
 */
export const AI_PROHIBITED_ADVICE_CLAUSE =
  '严格限制话题范围：不得提供投资、借贷、医疗或心理诊断方面的建议，' +
  '也不得给出任何具体的理财、用药、诊疗或心理干预方案；' +
  '若用户诉求落在这些范围，只提示其咨询相应专业人士，不展开具体内容。';

/**
 * 所有调用共用的输出格式约束。
 *
 * 要求「只输出 JSON」而不是「输出 JSON」：模型多写一句解释就会让 `JSON.parse`
 * 失败，草稿只能落 `failed`——把格式要求说不满，代价由用户承担。
 */
const JSON_ONLY_INSTRUCTION =
  '你只输出一个 JSON 对象，不要输出解释、Markdown 代码块标记或任何 JSON 之外的内容。' +
  'JSON 必须严格符合约定的字段结构，不要增加额外字段。';

/**
 * 四类调用的系统指令（与 `AiRequestType` 一一对应，缺一列即编译失败）。
 *
 * `expense_parse` 与 `review_summary` 属 AI-006，指令中必须带
 * {@link AI_PROHIBITED_ADVICE_CLAUSE}；`task_breakdown` / `schedule_suggestion`
 * 属 AI-004/005，不在 FR-083 的适用范围内，故不附加该约束。
 */
const SYSTEM_PROMPTS: Readonly<Record<AiRequestType, string>> = Object.freeze({
  task_breakdown:
    '你是个人生活管理助手，负责把用户的一句话目标拆解为可执行的小任务。' +
    JSON_ONLY_INSTRUCTION +
    '输出形如 { "suggestions": [ { "title": string, "estimatedMinutes": integer } ] }，' +
    '至少一条建议，estimatedMinutes 为 1 以上的整数分钟。',
  schedule_suggestion:
    '你是个人生活管理助手，负责把用户选定的任务安排进给定时间窗。' +
    '只依据用户选定的任务与给出的时间窗作答，不要引入其他任务。' +
    JSON_ONLY_INSTRUCTION +
    '输出形如 { "suggestions": [ { "taskId": string, "blockStart": ISO8601, ' +
    '"blockEnd": ISO8601, "reason": string } ] }，' +
    '每条建议必须给出 reason 说明为何这样安排，blockEnd 必须晚于 blockStart。',
  expense_parse:
    '你是个人记账助手，负责把用户的一句话消费描述解析为一笔开销草稿。' +
    JSON_ONLY_INSTRUCTION +
    '输出形如 { "amountMinor": integer, "currencyCode": string, "occurredOn": "YYYY-MM-DD", ' +
    '"categoryId": string|null, "note": string|null }；' +
    'amountMinor 为最小货币单位的正整数（整数分），currencyCode 为三字母 ISO 4217 代码。' +
    AI_PROHIBITED_ADVICE_CLAUSE,
  review_summary:
    '你是个人生活管理助手，负责依据用户提供的本周聚合数字给出复盘要点与改进建议。' +
    '只依据给出的聚合数字作答，不要臆测未提供的信息。' +
    JSON_ONLY_INSTRUCTION +
    '输出形如 { "summary": { "highlights": string[], "suggestions": string[] } }。' +
    AI_PROHIBITED_ADVICE_CLAUSE,
});

/** 取某类调用的系统指令（用例层唯一入口，避免直接索引常量表）。 */
export function systemPromptFor(requestType: AiRequestType): string {
  return SYSTEM_PROMPTS[requestType];
}
