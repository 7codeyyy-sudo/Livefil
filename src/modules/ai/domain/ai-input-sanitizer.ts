/**
 * AI 输入脱敏（AI-004 第 1 项，RD-20260929-006 §1.4）。
 *
 * ## 为什么是纯函数、且规则写死
 *
 * 脱敏是「把要出境的数据先改小、改干净」的最后一道人工关口。它不是模型能力问题，
 * 而是确定性规则问题——同一个输入永远得到同一个输出，才能被穷举测试，也才能在
 * 事后复算「当时究竟发出去了什么」。任何「智能推断敏感信息」的做法都会让
 * 结果随实现变化，与用 `input_hash` 做对账的意图相冲突。
 *
 * ## 只做四类白名单明确的掩码
 *
 * 规则逐条对齐 RD-006 §1.4：手机号（11 位连续数字）、邮箱、证件/银行卡（≥16 位
 * 连续数字）、URL 查询串里的 token 类参数。不做姓名/地址/自由文本的猜测式识别——
 * 误伤会让语义丢失，而漏掉的那一类本来就该由用户自己决定要不要输入。
 *
 * ## `input_hash` 对**脱敏后**文本取
 *
 * 依据 RD-006 §1.4 第 3 条「落 `input_hash = sha256(归一化后的 sanitized_input)`」。
 * （《数据库设计文档》§4.13.1 的列注释写作「脱敏前输入的哈希」，两处口径不一致；
 * 本轮按被本任务指定为准据的 RD-006 §1.4 执行，并在交付报告中标注该偏差。）
 */
import { createHash } from 'node:crypto';

/** 脱敏结果：送 provider 的文本与对账用的哈希。 */
export interface SanitizedAiInput {
  /** 脱敏并归一化后的文本（落 `ai_drafts.sanitized_input`）。 */
  readonly sanitizedInput: string;
  /** `sha256(sanitizedInput)` 的十六进制摘要（落 `ai_drafts.input_hash`）。 */
  readonly inputHash: string;
}

/** 掩码占位符。刻意区分类型，便于人工核查「哪一类命中过」。 */
const MASK_EMAIL = '[REDACTED_EMAIL]';
const MASK_PHONE = '[REDACTED_PHONE]';
const MASK_ID = '[REDACTED_ID]';
const MASK_TOKEN = '[REDACTED_TOKEN]';

/** 邮箱：本地部分 + @ + 域名。 */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * 证件 / 银行卡：≥16 位连续数字。
 *
 * 放在手机号之前执行：先吞掉长数字串，11 位规则就不会再从一段 16 位数字里
 * 切出一段 11 位来误标成手机号。
 */
const LONG_DIGIT_RUN_PATTERN = /\d{16,}/g;

/** 手机号：恰好 11 位连续数字（前后不是数字，避免从更长数字串里截取）。 */
const PHONE_PATTERN = /(?<!\d)\d{11}(?!\d)/g;

/** URL 查询串里的 token 类参数：保留参数名，掩掉取值（便于审计时看出「传过一个 token」）。 */
const TOKEN_QUERY_PATTERN =
  /([?&](?:token|access_token|api_key|apikey|auth|secret|signature|sig|key)=)[^&\s#]*/gi;

/** 控制字符（含换行、制表）：脱敏文本按单行处理，避免多行内容伪造日志/提示结构。 */
const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F]+/g;

/** 连续空白折叠为单个空格。 */
const WHITESPACE_RUN_PATTERN = /\s+/g;

/**
 * 对一段用户输入做脱敏与归一化。
 *
 * 处理顺序固定为：邮箱 → 长数字串 → 手机号 → URL token → 控制字符 → 空白折叠 →
 * 截断。顺序本身是契约的一部分：交换「长数字串」与「手机号」会让 16 位号码被
 * 切成 11 位再加 5 位，掩码结果不再稳定。
 *
 * @param raw 原始用户输入（可能是自由文本或结构化上下文的 JSON 文本）。
 * @param maxLength 截断上限（字符数），来自 `AI_MAX_INPUT_CHARS`。
 * @returns 脱敏后的文本与其 `sha256` 摘要。
 */
export function sanitizeAiInput(raw: string, maxLength: number): SanitizedAiInput {
  const masked = raw
    .replace(EMAIL_PATTERN, MASK_EMAIL)
    .replace(LONG_DIGIT_RUN_PATTERN, MASK_ID)
    .replace(PHONE_PATTERN, MASK_PHONE)
    .replace(TOKEN_QUERY_PATTERN, `$1${MASK_TOKEN}`);

  const normalized = masked
    .replace(CONTROL_CHARS_PATTERN, ' ')
    .replace(WHITESPACE_RUN_PATTERN, ' ')
    .trim();
  // `Math.max(0, ...)` 防止负上限（env 只放行非负整数，这里仍做一次防御，
  // 因为 slice 的负值语义是「从尾部取」，会静默产出完全不同的文本）。
  const sanitizedInput = normalized.slice(0, Math.max(0, maxLength));

  return {
    sanitizedInput,
    inputHash: createHash('sha256').update(sanitizedInput).digest('hex'),
  };
}
