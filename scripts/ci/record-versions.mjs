#!/usr/bin/env node
/**
 * 记录构建环境与数据层版本（FND-006）。
 *
 * 记录三项，与《开发任务清单》FND-006 的「记录 Node、包管理器和数据库迁移版本」对应：
 *   1. Node —— `.nvmrc` 声明的期望值与当前进程实际值对照；
 *   2. 包管理器 —— npm 版本与锁文件的 `lockfileVersion`；
 *   3. 数据库迁移 —— **探测式**取值，而不是写死的占位常量。
 *
 * 第 3 项为何要探测：当前项目尚未接入数据库（无 drizzle 依赖、无迁移目录），
 * 写一个假目录或 `000_placeholder` 只会制造噪音。而写成常量占位，
 * 等数据库任务落地后就必须回来改这里。探测式取值让同一个脚本自动跟上：
 * 一旦出现 `drizzle/meta/_journal.json`，它就会输出真实的迁移条目数与最新 tag，
 * workflow 与调用方式一行都不用改。
 *
 * 输出：设置了 `GITHUB_STEP_SUMMARY` 时写入该文件（即 Actions 的 Job Summary），
 * 否则打印到标准输出。两种情况下文本相同，便于本地与 CI 对照。
 *
 * 用法：
 *   npm run env:versions              记录并输出
 *   npm run env:versions -- --strict  额外校验实际 Node 版本必须等于 .nvmrc 声明值
 *
 * 本文件不含任何本机绝对路径。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT, formatPath } from '../env/paths.mjs';

const NODE_VERSION_FILE = path.join(PROJECT_ROOT, '.nvmrc');
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');
const LOCKFILE = path.join(PROJECT_ROOT, 'package-lock.json');

/** Drizzle 的迁移日志。它存在即代表已有迁移，条目顺序就是迁移顺序。 */
const DRIZZLE_JOURNAL = path.join(PROJECT_ROOT, 'drizzle', 'meta', '_journal.json');

const strict = process.argv.includes('--strict');

/**
 * 读取并解析 JSON 文件。
 *
 * @param {string} file 绝对路径。
 * @returns {Record<string, unknown> | undefined} 解析结果；文件缺失或非法时返回 undefined。
 */
function readJsonIfPresent(file) {
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 描述 Node 版本：期望值来自 `.nvmrc`，实际值来自当前进程。
 *
 * @returns {{ text: string, matches: boolean }} 展示文本与是否一致。
 */
function describeNode() {
  const actual = process.version.replace(/^v/, '');
  const expected = existsSync(NODE_VERSION_FILE)
    ? readFileSync(NODE_VERSION_FILE, 'utf8').trim()
    : '';

  if (expected === '') {
    return { text: `${actual}（缺少 .nvmrc，无法校验期望值）`, matches: true };
  }
  if (expected === actual) {
    return { text: `${actual}（期望 ${expected}，一致）`, matches: true };
  }
  return { text: `${actual}（期望 ${expected}，**不一致**）`, matches: false };
}

/**
 * 描述包管理器版本。
 *
 * npm 版本取自 `npm_config_user_agent`——它由 npm 在执行脚本时注入，
 * 因此无需启动子进程去问 npm（子进程方式在只装了项目便携运行时的机器上会失败，
 * 正是 FND-006 要消除的那类依赖）。直接 `node` 运行本脚本时该变量不存在，
 * 此时明确标注来源不可得，而不是猜一个值。
 *
 * @returns {string} 展示文本。
 */
function describePackageManager() {
  const agent = process.env.npm_config_user_agent ?? '';
  const npmMatch = /npm\/(\d+\.\d+\.\d+)/.exec(agent);
  const npmVersion = npmMatch?.[1] ?? '未知（未经 npm 运行）';

  const lockfile = readJsonIfPresent(LOCKFILE);
  const lockfileVersion = lockfile?.lockfileVersion ?? '未知';

  return `npm ${npmVersion}，lockfileVersion ${String(lockfileVersion)}`;
}

/**
 * 探测数据库迁移状态。
 *
 * @returns {string} 展示文本。
 */
function describeDatabaseMigrations() {
  const journal = readJsonIfPresent(DRIZZLE_JOURNAL);
  const entries = Array.isArray(journal?.entries) ? journal.entries : undefined;

  if (entries !== undefined && entries.length > 0) {
    const last = entries.at(-1);
    const tag = typeof last?.tag === 'string' ? last.tag : '(无 tag)';
    return `${entries.length} 条，最新 ${tag}`;
  }

  const pkg = readJsonIfPresent(PACKAGE_JSON);
  const dependencies = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };
  const drizzlePackages = Object.keys(dependencies).filter((name) => name.startsWith('drizzle-'));
  if (drizzlePackages.length > 0) {
    return `已引入 ${drizzlePackages.join('、')}，但尚无 ${formatPath(DRIZZLE_JOURNAL)}`;
  }

  return 'none（数据库未接入，首个迁移随数据库任务引入）';
}

const node = describeNode();

const lines = [
  '## 版本记录（FND-006）',
  '',
  `- node: ${node.text}`,
  `- package-manager: ${describePackageManager()}`,
  `- database-migrations: ${describeDatabaseMigrations()}`,
  '',
];

const report = lines.join('\n');
const summaryFile = process.env.GITHUB_STEP_SUMMARY;

if (summaryFile !== undefined && summaryFile !== '') {
  appendFileSync(summaryFile, `${report}\n`, 'utf8');
} else {
  console.log(report);
}

if (strict && !node.matches) {
  console.error('实际 Node 版本与 .nvmrc 声明不一致，请修正运行环境后重试。');
  process.exit(1);
}
