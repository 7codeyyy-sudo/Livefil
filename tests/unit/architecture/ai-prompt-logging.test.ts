/**
 * 「AI prompt 不得进入日志」的架构断言（RD-009 裁定 1 甲案·第 3 件）。
 *
 * ## 为什么需要它
 *
 * 《详细设计说明书》§9 与 SRS §6.7 都禁止记录「完整 AI prompt」，而
 * `FORBIDDEN_FIELD_NAME_FRAGMENTS` 在 RD-009 之前并不含 `prompt`——该缺口只靠
 * 200 字符截断兜着（第 1 件已补上清单）。这个文件是第 3 件：把「别把 prompt 交给
 * 日志」从注释里的约定变成会让构建失败的可执行检查。
 *
 * ## 为什么必须带「扫到 0 个文件即失败」
 *
 * `src/modules/ai/**` 与 `app/api/v1/ai/**` 在本批开工时还是空占位，纯否定式断言
 * （「没找到违规」）在空目录上平凡成立——那是永远通过的假用例（PD-018 §六⑦ /
 * IAM-004 立规）。所以这里同时断言**被扫描文件数 > 0**：AI 源码还没落地时这条
 * 检查就该红，而不是假装自己检查过了。它与三件套的落点次序（RD-009 裁定 3：
 * AI-003 首批代码紧随其后）互为保险。
 *
 * ## 检测口径：与脱敏清单同源，刻意偏保守
 *
 * 判据是「日志调用的实参里出现 `prompt` 字样」（子串、大小写不敏感），必要时先
 * 剔除字符串字面量。于是 `prompt` / `systemPrompt` / `prompt_text` / `PROMPT` /
 * `promptTokens` 全在命中面内——这与 [redaction.ts](../../../src/shared/telemetry/redaction.ts)
 * 的归一化子串命中**同一口径**：既然这些字段名在运行时都会被整体替换成占位符，
 * 把它们写进日志本就没有意义，拦在提交前比事后脱敏更便宜。
 *
 * 日志文案里的 `prompt` 字样（如 `'输入 prompt 过长'`）不算违规：字符串字面量先被
 * 剔除，它既不是 context 键也不是被打印的值。
 *
 * ## 已知边界
 *
 * 解析基于正则而非 AST，因此：
 * - 间接形态检不出来（先把 prompt 存进变量或对象、再把变量交给日志）；
 * - 模板字符串里的 `${}` 不展开；
 * - 非 `logger*` / `console` 命名的日志对象（如 `auditLogger` 之外的别名）可能漏检。
 *
 * 方向一律是**漏检**而非误报：它是兜底防线，不是脱敏的替代品——真正的防线仍是
 * `redactRecord`（第 1、2 件）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectSourceFiles, stripComments } from './imports.ts';

/** 项目根（`tests/unit/architecture` 向上三层）。 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 受扫描的 AI 源码目录（相对项目根，POSIX 风格）。 */
const SCANNED_DIRECTORIES: readonly string[] = ['src/modules/ai', 'app/api/v1/ai'];

/** 日志方法名；`child` 也是日志 context 的写入口（绑定字段会进入此后每条记录）。 */
const LOG_METHODS = 'debug|info|warn|error|log|trace|child';

/**
 * 候选形态「标识符.方法(」。
 *
 * 对象名是否为日志对象交给 {@link isLoggerIdentifier} 判定：`\b` 词边界在这里不够用
 * （`auditLogger` 里 `logger` 前是词字符，`\blogger\b` 匹配不到），而放宽成任意
 * `x.info(` 又会把普通对象的同方法名误报。两步走既覆盖变体，也不误伤。
 */
const CALL_PATTERN = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*(?:${LOG_METHODS})\\s*\\(`, 'g');

/** 字符串字面量（含模板字符串）：检测前替换掉，免得日志文案里的字样被误判。 */
const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/** `prompt` 字样（子串、大小写不敏感，见文件头口径说明）。 */
const PROMPT_MENTION = /prompt/i;

/**
 * 判断调用方标识符是否是日志对象。
 *
 * @param name 点号左侧的标识符。
 * @returns `console`、`log`，或以 `logger` 结尾（大小写不敏感）时为 true。
 */
function isLoggerIdentifier(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === 'console' || normalized === 'log' || normalized.endsWith('logger');
}

/**
 * 取出一次调用的实参文本（括号配对，跳过字符串字面量）。
 *
 * @param source 已剥离注释的源码。
 * @param openParenIndex 左括号的下标。
 * @returns 实参文本；括号未闭合时取到文件尾——宁可多看一眼，不静默放过。
 */
function extractCallArguments(source: string, openParenIndex: number): string {
  let depth = 0;
  let quote: string | null = null;

  for (let index = openParenIndex; index < source.length; index += 1) {
    const character = source[index];

    if (quote !== null) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }

    if (character === '(') {
      depth += 1;
      continue;
    }

    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openParenIndex + 1, index);
      }
    }
  }

  return source.slice(openParenIndex + 1);
}

/**
 * 找出源码中把 `prompt` 交给日志的调用。
 *
 * @param source 源码内容（可含注释，内部会先剥离）。
 * @returns 命中的调用表达式文本（已 trim），无命中时为空数组。
 */
function findPromptLoggingViolations(source: string): readonly string[] {
  const code = stripComments(source);
  const violations: string[] = [];

  // 带 `g` 的正则会被 matchAll 复制并沿用 lastIndex；跨文件复用同一实例前必须重置，
  // 否则会漏掉前面的匹配（同 `imports.ts` 的既有注释）。
  for (const call of code.matchAll(new RegExp(CALL_PATTERN.source, 'g'))) {
    if (!isLoggerIdentifier(call[1] ?? '')) {
      continue;
    }

    const openParenIndex = (call.index ?? 0) + call[0].length - 1;
    const args = extractCallArguments(code, openParenIndex).replaceAll(STRING_LITERAL, ' ');

    if (PROMPT_MENTION.test(args)) {
      violations.push(call[0].trim());
    }
  }

  return violations;
}

/** 受扫描文件（模块加载时收集一次，两个断言块共用同一份事实）。 */
const scannedFiles = SCANNED_DIRECTORIES.flatMap((directory) =>
  collectSourceFiles(path.join(PROJECT_ROOT, directory), PROJECT_ROOT),
);

describe('AI prompt 不进入日志（真实源码）', () => {
  it('扫描到了 AI 模块源码——空目录上的平凡通过按失败处理', () => {
    expect(
      scannedFiles.length,
      `受扫描目录：${SCANNED_DIRECTORIES.join('、')}；一个源文件都没有，本断言视为失败`,
    ).toBeGreaterThan(0);
  });

  it('src/modules/ai 与 app/api/v1/ai 下的日志调用都不含 prompt 字样', () => {
    const violations = scannedFiles.flatMap((file) =>
      findPromptLoggingViolations(file.content).map((call) => `${file.relativePath}: ${call}`),
    );

    expect(violations, `以下调用把 prompt 交给了日志：${violations.join(' | ')}`).toEqual([]);
  });
});

describe('检查器自证', () => {
  it('把 prompt 直接传入 logger 会被检出', () => {
    expect(findPromptLoggingViolations("logger.info('生成草稿', prompt);")).toHaveLength(1);
  });

  it('把 prompt 作为日志 context 键会被检出', () => {
    expect(findPromptLoggingViolations("logger.info('生成草稿', { prompt: value });")).toHaveLength(
      1,
    );
  });

  it('变体 systemPrompt 与 logger.child 绑定同样会被检出', () => {
    expect(
      findPromptLoggingViolations("logger.child({ systemPrompt: value }).info('开始');"),
    ).toHaveLength(1);
  });

  it('不含 prompt 的正常日志不会被误报', () => {
    expect(
      findPromptLoggingViolations("logger.info('生成草稿', { model: value, durationMs: 12 });"),
    ).toEqual([]);
  });

  it('日志文案里出现 prompt 字样不算违规——那不是 context 键、也不是被打印的值', () => {
    expect(
      findPromptLoggingViolations("logger.warn('输入 prompt 过长，已截断', { model });"),
    ).toEqual([]);
  });

  it('同名的普通对象方法不会被误报', () => {
    expect(findPromptLoggingViolations("builder.info('开始', { prompt: value });")).toEqual([]);
  });

  it('注释里的示例不会被误判为真实调用', () => {
    const source = ["// logger.info('x', { prompt: v });", "logger.info('y', { model });"].join(
      '\n',
    );

    expect(findPromptLoggingViolations(source)).toEqual([]);
  });
});
