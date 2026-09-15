#!/usr/bin/env node
/**
 * ENV-001 开发环境路径检查。
 *
 * 逐项验证：
 * 1. 项目根目录由标记文件动态解析，不依赖写死的本机绝对路径。
 * 2. 项目内便携 Node 存在且版本与 .nvmrc 一致。
 * 3. 依赖安装位置在项目内。
 * 4. npm 生效缓存目录落在项目内。
 * 5. .runtime / .cache / .data 等运行数据目录齐备。
 * 6. .env.local 未被 Git 跟踪，且已被 .gitignore 覆盖。
 * 7. 代码、配置与脚本中没有硬编码的本机绝对路径。
 * 8. 文档与原型中的路径写法（命中记为 WARN，既有文档另行排期修正）。
 *
 * 退出码：0 = 无 FAIL（允许 WARN）；1 = 存在 FAIL。
 * 用法：npm run env:check
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  MANAGED_DIRECTORIES,
  PATHS,
  PROJECT_ROOT,
  formatPath,
  isInside,
  projectEnv,
  resolveProjectRoot,
} from './paths.mjs';
import { resolveNpmInvocation } from './npm-command.mjs';

const LEVEL = Object.freeze({ PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' });

/** @type {{ level: string, title: string, detail: string }[]} */
const results = [];

function record(level, title, detail) {
  results.push({ level, title, detail });
}

/** 把路径规范化为可比较的形式（Windows 下大小写不敏感）。 */
function normalizeForCompare(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 执行外部命令并返回结果，不做静默吞错：无法启动时返回 error。 */
function run(command, args, options = {}) {
  const outcome = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    ...options,
  });
  return {
    started: outcome.error === undefined,
    startError: outcome.error,
    status: outcome.status,
    stdout: (outcome.stdout ?? '').trim(),
    stderr: (outcome.stderr ?? '').trim(),
  };
}

/** 以项目环境变量执行 npm 并捕获输出。 */
function runNpm(args) {
  const invocation = resolveNpmInvocation();
  const outcome = run(invocation.command, [...invocation.prefixArgs, ...args], {
    env: projectEnv(),
    shell: invocation.useShell,
  });
  return { ...outcome, invocation };
}

function checkProjectRootResolution() {
  const fromProcessCwd = resolveProjectRoot(process.cwd());
  const fromScriptDir = resolveProjectRoot(PATHS.scripts);
  if (fromProcessCwd === PROJECT_ROOT && fromScriptDir === PROJECT_ROOT) {
    record(
      LEVEL.PASS,
      '项目根目录动态解析',
      '由标记文件 doc/README.md 向上查找确定；从项目根与 scripts 子目录启动结果一致。',
    );
    return;
  }
  record(
    LEVEL.FAIL,
    '项目根目录动态解析',
    `不同起点解析结果不一致：cwd=${formatPath(fromProcessCwd)}，scripts=${formatPath(fromScriptDir)}。`,
  );
}

function checkPortableRuntime() {
  const nodeExecutable = path.join(
    PATHS.portableNode,
    process.platform === 'win32' ? 'node.exe' : 'bin/node',
  );
  if (!existsSync(nodeExecutable)) {
    record(
      LEVEL.WARN,
      '项目内便携 Node 运行时',
      `.runtime/node 未安装。ENV-002 要求固定 Node 版本，请按《开发环境规范》§3.1 补齐便携运行时。`,
    );
    return;
  }

  const versionResult = run(nodeExecutable, ['-v']);
  if (!versionResult.started || versionResult.status !== 0) {
    record(
      LEVEL.FAIL,
      '项目内便携 Node 运行时',
      `无法执行 ${formatPath(nodeExecutable)}：${versionResult.startError?.message ?? versionResult.stderr}`,
    );
    return;
  }

  const actualVersion = versionResult.stdout.replace(/^v/, '');
  const expectedVersion = existsSync(PATHS.nodeVersionFile)
    ? readFileSync(PATHS.nodeVersionFile, 'utf8').trim()
    : '';
  if (expectedVersion === '') {
    record(
      LEVEL.WARN,
      '项目内便携 Node 运行时',
      `已安装 v${actualVersion}，但缺少 .nvmrc，无法校验固定版本。`,
    );
    return;
  }
  if (actualVersion === expectedVersion) {
    record(
      LEVEL.PASS,
      '项目内便携 Node 运行时',
      `v${actualVersion}，与 .nvmrc 声明的固定版本一致。`,
    );
    return;
  }
  record(
    LEVEL.FAIL,
    '项目内便携 Node 运行时',
    `实际 v${actualVersion} 与 .nvmrc 声明 v${expectedVersion} 不一致，请补齐或重新固定版本。`,
  );
}

function checkDependencyLocation() {
  if (!existsSync(PATHS.nodeModules)) {
    // node_modules 尚未生成时，改为校验 npm 解析出的安装位置，避免只给出「无法判断」。
    const outcome = runNpm(['root']);
    if (!outcome.started) {
      record(
        LEVEL.WARN,
        '依赖安装位置',
        `无法启动 npm 校验安装位置：${outcome.startError?.message}`,
      );
      return;
    }
    if (outcome.status !== 0 || outcome.stdout === '') {
      record(LEVEL.WARN, '依赖安装位置', `npm root 未返回结果：${outcome.stderr || '无错误输出'}`);
      return;
    }
    if (normalizeForCompare(outcome.stdout) !== normalizeForCompare(PATHS.nodeModules)) {
      record(
        LEVEL.FAIL,
        '依赖安装位置',
        `npm 解析的安装目录为 ${outcome.stdout}，期望 ${formatPath(PATHS.nodeModules)}。`,
      );
      return;
    }
    record(
      LEVEL.PASS,
      '依赖安装位置',
      `依赖尚未安装，但 npm 解析的安装目录为 ${formatPath(PATHS.nodeModules)}（${outcome.invocation.description}）。`,
    );
    return;
  }
  const stats = lstatSync(PATHS.nodeModules);
  if (!stats.isDirectory()) {
    record(LEVEL.FAIL, '依赖安装位置', `${formatPath(PATHS.nodeModules)} 存在但不是目录。`);
    return;
  }
  if (stats.isSymbolicLink()) {
    const realTarget = realpathSync(PATHS.nodeModules);
    if (!isInside(PROJECT_ROOT, realTarget)) {
      record(LEVEL.FAIL, '依赖安装位置', `node_modules 是符号链接且指向项目外目录。`);
      return;
    }
    record(LEVEL.PASS, '依赖安装位置', 'node_modules 为项目内符号链接，指向项目内目录。');
    return;
  }
  record(LEVEL.PASS, '依赖安装位置', `依赖安装在 ${formatPath(PATHS.nodeModules)}。`);
}

function checkNpmCacheLocation() {
  const outcome = runNpm(['config', 'get', 'cache']);

  if (!outcome.started) {
    record(
      LEVEL.WARN,
      'npm 缓存目录',
      `无法启动 npm（${outcome.invocation.description}）：${outcome.startError?.message}`,
    );
    return;
  }
  if (outcome.status !== 0 || outcome.stdout === '') {
    record(
      LEVEL.WARN,
      'npm 缓存目录',
      `npm config get cache 未返回结果（${outcome.invocation.description}）：${outcome.stderr || '无错误输出'}`,
    );
    return;
  }

  const effectiveCache = outcome.stdout;
  if (normalizeForCompare(effectiveCache) !== normalizeForCompare(PATHS.npmCache)) {
    record(
      LEVEL.FAIL,
      'npm 缓存目录',
      `生效缓存为 ${effectiveCache}，期望 ${formatPath(PATHS.npmCache)}。请通过 npm run env:npm -- <参数> 执行安装命令。`,
    );
    return;
  }
  record(
    LEVEL.PASS,
    'npm 缓存目录',
    `生效缓存为 ${formatPath(PATHS.npmCache)}（调用方式：${outcome.invocation.description}）。`,
  );
}

function checkManagedDirectories() {
  const missing = MANAGED_DIRECTORIES.filter((directory) => !existsSync(directory));
  if (missing.length === 0) {
    record(
      LEVEL.PASS,
      '项目内运行数据目录',
      `已创建 ${MANAGED_DIRECTORIES.length} 个目录（.runtime / .cache / .data）。`,
    );
    return;
  }
  record(
    LEVEL.FAIL,
    '项目内运行数据目录',
    `缺少 ${missing.length} 个目录：${missing.map(formatPath).join('、')}。请执行 npm run env:bootstrap。`,
  );
}

function checkEnvLocalIgnoreRule() {
  if (!existsSync(PATHS.gitIgnore)) {
    record(LEVEL.FAIL, '忽略规则覆盖 .env.local', '.gitignore 不存在，本地秘密文件可能被误提交。');
    return;
  }
  const rules = readFileSync(PATHS.gitIgnore, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (rules.includes('.env.local')) {
    record(LEVEL.PASS, '忽略规则覆盖 .env.local', '.gitignore 已显式忽略 .env.local。');
    return;
  }
  record(LEVEL.FAIL, '忽略规则覆盖 .env.local', '.gitignore 未包含 .env.local 规则。');
}

function checkEnvLocalTracking() {
  const gitAvailable = run('git', ['--version']);
  if (!gitAvailable.started) {
    record(LEVEL.WARN, '.env.local 的 Git 跟踪状态', '当前环境无法执行 git，无法校验。');
    return;
  }

  const tracked = run('git', ['ls-files', '--error-unmatch', '--', '.env.local']);
  if (tracked.status === 0) {
    record(
      LEVEL.FAIL,
      '.env.local 的 Git 跟踪状态',
      '.env.local 已被 Git 跟踪，请立即执行 git rm --cached .env.local 并轮换其中所有密钥。',
    );
    return;
  }
  if (tracked.stderr.includes('not a git repository')) {
    record(
      LEVEL.WARN,
      '.env.local 的 Git 跟踪状态',
      '当前目录尚未初始化 Git 仓库，ENV-001 该项待仓库初始化后复查。',
    );
    return;
  }
  record(LEVEL.PASS, '.env.local 的 Git 跟踪状态', '.env.local 未被 Git 跟踪。');
}

/**
 * 构造硬编码路径检测规则。
 *
 * 规则拼接而非直接书写字面量，避免检查脚本匹配到自身。
 * 盘符规则要求冒号前是「行首或非单词字符」，用于排除 `postgresql://`、`postgres:/var`
 * 这类 URI 与容器挂载点写法造成的误报。
 */
function buildAbsolutePathRules() {
  return [
    {
      name: 'Windows 盘符绝对路径',
      pattern: new RegExp('(^|[^A-Za-z0-9_])[A-Za-z]:[\\\\/](?![\\\\/])'),
    },
    {
      name: 'POSIX 用户目录',
      pattern: new RegExp('(^|[^A-Za-z0-9_])/' + '(?:Users|home)/'),
    },
  ];
}

/** 判断文件是否应纳入扫描（存在且为普通文件）。 */
function isScannableFile(file) {
  return existsSync(file) && statSync(file).isFile();
}

/** 收集需要扫描硬编码路径的代码与配置文件。 */
function collectScannableFiles() {
  const explicitFiles = [
    PATHS.packageJson,
    path.join(PROJECT_ROOT, '.npmrc'),
    PATHS.envExample,
    PATHS.gitIgnore,
    path.join(PATHS.docker, 'compose.dev.yaml'),
  ];
  const scriptFiles = collectFilesByExtension(PATHS.scripts, ['.mjs']);
  return [...explicitFiles, ...scriptFiles].filter(isScannableFile);
}

/** 递归收集目录下的指定后缀文件。 */
function collectFilesByExtension(rootDirectory, extensions) {
  if (!existsSync(rootDirectory)) {
    return [];
  }
  const collected = [];
  for (const entry of readdirSync(rootDirectory, { withFileTypes: true })) {
    const entryPath = path.join(rootDirectory, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectFilesByExtension(entryPath, extensions));
      continue;
    }
    if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
      collected.push(entryPath);
    }
  }
  return collected;
}

/** 在指定文件集合中查找硬编码路径，返回可读的命中列表。 */
function findAbsolutePathOffenders(files) {
  const rules = buildAbsolutePathRules();
  const offenders = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of rules) {
        if (rule.pattern.test(line)) {
          offenders.push(`${formatPath(file)}:${index + 1} [${rule.name}] ${line.trim()}`);
        }
      }
    });
  }
  return offenders;
}

function checkHardcodedAbsolutePaths() {
  const scannableFiles = collectScannableFiles();
  const offenders = findAbsolutePathOffenders(scannableFiles);
  if (offenders.length === 0) {
    record(
      LEVEL.PASS,
      '代码与配置无硬编码本机路径',
      `已扫描 ${scannableFiles.length} 个代码与配置文件。`,
    );
    return;
  }
  record(
    LEVEL.FAIL,
    '代码与配置无硬编码本机路径',
    `发现 ${offenders.length} 处：\n      ${offenders.join('\n      ')}`,
  );
}

/**
 * 文档与原型中的路径扫描。
 * 既有文档属于用户已确认的基线，不在环境任务中改动，命中时记为 WARN 并另行排期。
 */
function checkDocumentationPaths() {
  const documentationFiles = [
    ...collectFilesByExtension(path.join(PROJECT_ROOT, 'doc'), ['.md']),
    ...collectFilesByExtension(path.join(PROJECT_ROOT, 'prototype'), ['.html', '.css', '.js']),
  ];
  const offenders = findAbsolutePathOffenders(documentationFiles);
  if (offenders.length === 0) {
    record(
      LEVEL.PASS,
      '文档与原型无硬编码本机路径',
      `已扫描 ${documentationFiles.length} 个文档与原型文件。`,
    );
    return;
  }
  record(
    LEVEL.WARN,
    '文档与原型无硬编码本机路径',
    `发现 ${offenders.length} 处（属既有文档，需另行排期修正）：\n      ${offenders.join('\n      ')}`,
  );
}

function printReport() {
  const width = Math.max(...results.map((item) => item.title.length));
  console.log(`项目根目录：${PROJECT_ROOT}`);
  console.log('');
  for (const item of results) {
    console.log(`${item.level.padEnd(4)}  ${item.title.padEnd(width)}  ${item.detail}`);
  }
  const count = (level) => results.filter((item) => item.level === level).length;
  console.log('');
  console.log(
    `汇总：PASS ${count(LEVEL.PASS)} | WARN ${count(LEVEL.WARN)} | FAIL ${count(LEVEL.FAIL)}`,
  );
}

checkProjectRootResolution();
checkPortableRuntime();
checkManagedDirectories();
checkDependencyLocation();
checkNpmCacheLocation();
checkEnvLocalIgnoreRule();
checkEnvLocalTracking();
checkHardcodedAbsolutePaths();
checkDocumentationPaths();

printReport();

process.exit(results.some((item) => item.level === LEVEL.FAIL) ? 1 : 0);
