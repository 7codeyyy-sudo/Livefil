/**
 * FND-004 验收脚本。
 *
 * 把任务验收标准固化为可复现的自动检查，而不是一次性的人工验证：
 *   1. 十三层业务模块目录齐备，且与《概要设计说明书》§5 的模块划分一致。
 *   2. 每个模块都有 domain / application / infrastructure / presentation 四层。
 *   3. `src/shared` 与 `src/infrastructure` 的子目录齐备。
 *   4. 依赖边界规则表就位，且**真的能拦住违规**——用探针实际跑一遍 ESLint，
 *      而不是只检查配置文本里出现了某个字符串。
 *   5. 约束覆盖到每一个受约束的层，不存在「没人管」的目录。
 *   6. 新增源码不含硬编码的机器绝对路径。
 *
 * 运行：npm run test:e2e
 *
 * 关于第 4 条为何要做行为验证：配置里写了规则，与规则真的生效，是两件事。
 * ESLint 的文件匹配（`files` glob）写错时，规则会被静默跳过——配置文本检查
 * 完全发现不了，而探针可以。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolveNpmInvocation } from '../../scripts/env/npm-command.mjs';
import { PATHS, PROJECT_ROOT, formatPath, projectEnv } from '../../scripts/env/paths.mjs';

/** 单条外部命令的最长等待时间。 */
const COMMAND_TIMEOUT_MS = 300_000;

/** 《概要设计说明书》§5 定义的业务模块，顺序与文档表格一致。 */
const EXPECTED_MODULES = [
  'identity',
  'life-areas',
  'tasks',
  'goals',
  'scheduling',
  'routines',
  'execution',
  'expenses',
  'reviews',
  'notifications',
  'sync',
  'ai',
  'data-management',
];

/** 《详细设计说明书》§2 规定的模块内分层。 */
const EXPECTED_LAYERS = ['domain', 'application', 'infrastructure', 'presentation'];

/**
 * `src/shared` 的子目录（validation 由 FND-001 建立，其余属本任务；`ui` 由 UI-001 后加入）。
 *
 * 这是一份**显式清单**而不是从文件系统推导——目录结构属契约，
 * 新增或删除都应当在这里留下痕迹，而不是被自动放行。
 */
const EXPECTED_SHARED_AREAS = [
  'validation',
  'domain',
  'date-time',
  'money',
  'errors',
  'telemetry',
  'ui',
];

/** `src/infrastructure` 的子目录。 */
const EXPECTED_INFRASTRUCTURE_AREAS = [
  'database',
  'auth',
  'ai-providers',
  'notifications',
  'cache',
];

const ARCHITECTURE_DIR = path.join(PROJECT_ROOT, 'tests', 'unit', 'architecture');
const DEPENDENCY_RULES_FILE = path.join(ARCHITECTURE_DIR, 'dependency-rules.ts');
const DEPENDENCY_TEST_FILE = path.join(ARCHITECTURE_DIR, 'dependency-boundaries.test.ts');
const ESLINT_CONFIG = path.join(PROJECT_ROOT, 'eslint.config.mjs');

const nodeExecutable = (() => {
  const portable = path.join(
    PATHS.portableNode,
    process.platform === 'win32' ? 'node.exe' : 'bin/node',
  );
  return existsSync(portable) ? portable : process.execPath;
})();

/** 项目内的 ESLint CLI。 */
const eslintBin = path.join(PROJECT_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');

/**
 * 机器绝对路径的形态：盘符、macOS/Linux 家目录、用户目录。
 *
 * 盘符模式要求冒号前是**孤立的**单个字母：否则 `https://` 中的 `s:/`
 * 会被当成盘符，让每个含 URL 的文件都被判成违规。
 */
const ABSOLUTE_PATH_PATTERNS = [
  /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/,
  /\/Users\//,
  /\/home\//,
  /%USERPROFILE%/,
  /%APPDATA%/,
];

/**
 * 执行一条外部命令并收集输出。
 *
 * @param {string} command 可执行文件。
 * @param {readonly string[]} args 参数列表。
 * @param {{ input?: string, timeoutMs?: number, shell?: boolean }} [options] 可选输入、超时与 shell。
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, output: string }>}
 *   退出码与输出；`output` 为 stdout 与 stderr 的拼接，便于失败时完整展示。
 */
function runCommand(command, args, options = {}) {
  const { input, timeoutMs = COMMAND_TIMEOUT_MS, shell = false } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env: projectEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      const detail = `${stdout}${stderr}`;
      reject(new Error(`命令超时（${timeoutMs}ms）：${command} ${args.join(' ')}\n${detail}`));
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, output: `${stdout}${stderr}` });
    });

    child.stdin.end(input ?? '');
  });
}

/**
 * 用 Node 执行一条命令（首项为脚本路径）。
 *
 * @param {readonly string[]} args 传给 Node 的参数。
 * @param {{ input?: string, timeoutMs?: number }} [options] 可选输入与超时。
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, output: string }>}
 */
function runNode(args, options = {}) {
  return runCommand(nodeExecutable, args, options);
}

/**
 * 经 npm 执行指定参数。
 *
 * 刻意不复用 `PATHS.portableNode` 下的 npm-cli.js：`.runtime/` 不入库，
 * 在没有便携运行时的机器上（CI 即如此）那条路径必然不存在——而且它写死的还是
 * Windows 布局，POSIX 发行包的路径并不相同。
 * `resolveNpmInvocation()` 与 `npm run env:npm` 包装器同源，已覆盖便携的两种布局
 * 与系统 npm 回退（含 Windows 下 npm.cmd 的 shell 处理），不产生第二套探测逻辑。
 *
 * @param {readonly string[]} args 传给 npm 的参数。
 * @param {{ input?: string, timeoutMs?: number }} [options] 可选输入与超时。
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, output: string }>}
 */
function runNpm(args, options = {}) {
  const invocation = resolveNpmInvocation();
  return runCommand(invocation.command, [...invocation.prefixArgs, ...args], {
    ...options,
    shell: invocation.useShell,
  });
}

/**
 * 读取项目内文件；缺失时给出可读的失败信息。
 *
 * @param {string} absolutePath 目标文件绝对路径。
 * @returns {string} 文件内容。
 */
function readProjectFile(absolutePath) {
  assert.ok(existsSync(absolutePath), `缺少文件：${formatPath(absolutePath)}`);
  return readFileSync(absolutePath, 'utf8');
}

/**
 * 判断路径是否为目录。
 *
 * @param {string} relativePath 相对项目根的路径。
 * @returns {boolean} 是目录时为 true。
 */
function isDirectory(relativePath) {
  return existsSync(path.join(PROJECT_ROOT, relativePath));
}

/**
 * 列出目录下的子目录名。
 *
 * @param {string} relativePath 相对项目根的目录路径。
 * @returns {readonly string[]} 子目录名（已排序）。
 */
function listSubdirectories(relativePath) {
  const absolute = path.join(PROJECT_ROOT, relativePath);
  assert.ok(existsSync(absolute), `缺少目录：${relativePath}`);

  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * 推导全部应受依赖规则约束的目录。
 *
 * 从**实际目录结构**推导，而不是维护手写清单：上一版的清单漏掉了
 * `src/modules/<模块>/infrastructure`（13 个目录），使那一层完全没有约束，
 * 而覆盖度检查自己发现不了这件事——手写清单无法自证完整性。
 * 改为从文件系统推导后，新增模块或新增层会自动纳入检查范围。
 *
 * @returns {readonly string[]} 受约束目录的相对路径。
 */
function collectConstrainedDirectories() {
  const directories = ['app', 'src/infrastructure', 'src/shared'];

  for (const moduleName of listSubdirectories('src/modules')) {
    for (const layer of listSubdirectories(`src/modules/${moduleName}`)) {
      directories.push(`src/modules/${moduleName}/${layer}`);
    }
  }

  return directories;
}

/**
 * 递归收集目录下的源文件内容。
 *
 * @param {string} relativeDir 相对项目根的目录。
 * @returns {readonly { readonly relativePath: string, readonly content: string }[]}
 */
function collectSourceFiles(relativeDir) {
  const absoluteDir = path.join(PROJECT_ROOT, relativeDir);
  if (!existsSync(absoluteDir)) {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const childRelative = `${relativeDir}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(childRelative));
      continue;
    }

    if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
      files.push({
        relativePath: childRelative,
        content: readFileSync(path.join(absoluteDir, entry.name), 'utf8'),
      });
    }
  }
  return files;
}

test('十三个业务模块目录齐备，且与《概要设计》§5 一致', () => {
  const actualModules = listSubdirectories('src/modules');

  assert.deepEqual(
    actualModules,
    [...EXPECTED_MODULES].sort(),
    'src/modules 下的模块集合必须与《概要设计说明书》§5 的模块划分完全一致' +
      '（多建或少建都意味着代码与架构文档已经脱节）',
  );
});

test('每个模块都有四层目录', () => {
  const missing = [];

  for (const moduleName of EXPECTED_MODULES) {
    for (const layer of EXPECTED_LAYERS) {
      const relative = `src/modules/${moduleName}/${layer}`;
      if (!isDirectory(relative)) {
        missing.push(relative);
      }
    }
  }

  assert.deepEqual(missing, [], `缺少分层目录：\n${missing.join('\n')}`);
});

test('src/shared 与 src/infrastructure 的子目录齐备', () => {
  assert.deepEqual(
    listSubdirectories('src/shared'),
    [...EXPECTED_SHARED_AREAS].sort(),
    'src/shared 的子目录应与《详细设计说明书》§2 一致',
  );

  assert.deepEqual(
    listSubdirectories('src/infrastructure'),
    [...EXPECTED_INFRASTRUCTURE_AREAS].sort(),
    'src/infrastructure 的子目录应与《详细设计说明书》§2 一致',
  );
});

test('依赖规则表覆盖每一个受约束的目录', async () => {
  assert.ok(
    existsSync(DEPENDENCY_RULES_FILE),
    `缺少依赖规则模块：${formatPath(DEPENDENCY_RULES_FILE)}`,
  );
  assert.ok(
    existsSync(DEPENDENCY_TEST_FILE),
    `缺少依赖边界测试：${formatPath(DEPENDENCY_TEST_FILE)}`,
  );

  // 直接加载规则模块做真实判定，而不是在配置文本里找关键词。
  // 文本匹配会被注释与无关字符串满足，无法证明规则真的覆盖了目标目录——
  // 上一轮就正是因此把「src/infrastructure/database」误判成未覆盖。
  const { DEPENDENCY_RULES, matchesDirectoryPattern } = await import(
    pathToFileURL(DEPENDENCY_RULES_FILE).href
  );

  assert.ok(DEPENDENCY_RULES.length > 0, '依赖规则表不应为空');

  const constrainedDirectories = collectConstrainedDirectories();

  // 前提校验：必须真的覆盖到模块内基础设施层。没有这一步，这条用例可能在
  // 「什么都没检查到」的情况下通过——上一版正是这样漏掉了 13 个目录。
  assert.ok(
    constrainedDirectories.includes('src/modules/tasks/infrastructure'),
    '覆盖度检查必须包含模块内基础设施层',
  );

  const uncovered = constrainedDirectories.filter(
    (directory) =>
      !DEPENDENCY_RULES.some((rule) => matchesDirectoryPattern(directory, rule.appliesTo)),
  );

  assert.deepEqual(uncovered, [], `以下目录没有对应的依赖规则：\n${uncovered.join('\n')}`);
});

test('ESLint 分层规则能实际拦住违规（行为验证）', async () => {
  const eslintConfig = readProjectFile(ESLINT_CONFIG);

  assert.match(
    eslintConfig,
    /no-restricted-imports/,
    'eslint 配置应包含分层依赖的 no-restricted-imports 规则',
  );
  assert.match(eslintConfig, /src\/modules\/\*\/domain/, '分层规则应作用于领域层目录');

  // 探针：领域层引用 next —— 必须被拦下。
  const violating = await runNode(
    [
      eslintBin,
      '--stdin',
      '--stdin-filename',
      'src/modules/tasks/domain/__probe__.ts',
      '--format',
      'json',
    ],
    { input: "import { NextResponse } from 'next/server';\nexport const probe = NextResponse;\n" },
  );

  assert.notEqual(violating.code, 0, '领域层引用 next/server 应让 lint 失败');
  assert.match(
    violating.stdout,
    /no-restricted-imports/,
    `应报出 no-restricted-imports：\n${violating.output}`,
  );

  // 反向探针：应用层的同类引用**不应**被这条规则拦下，
  // 否则说明 files 匹配过宽，会误伤其他层。
  const allowed = await runNode(
    [
      eslintBin,
      '--stdin',
      '--stdin-filename',
      'src/modules/tasks/application/__probe__.ts',
      '--format',
      'json',
    ],
    { input: "import { NextResponse } from 'next/server';\nexport const probe = NextResponse;\n" },
  );

  const allowedReports = JSON.parse(allowed.stdout || '[]');
  const allowedRuleIds = allowedReports.flatMap((report) =>
    (report.messages ?? []).map((message) => message.ruleId),
  );

  assert.ok(
    !allowedRuleIds.includes('no-restricted-imports'),
    '分层规则不应作用于应用层——files 匹配过宽会导致误伤',
  );
});

test('新增源码不含硬编码的机器绝对路径', () => {
  const scannedFiles = [
    ...collectSourceFiles('src'),
    ...collectSourceFiles('tests/unit/architecture'),
    { relativePath: 'eslint.config.mjs', content: readProjectFile(ESLINT_CONFIG) },
  ];

  const offenders = [];

  for (const file of scannedFiles) {
    file.content.split(/\r?\n/).forEach((line, index) => {
      for (const pattern of ABSOLUTE_PATH_PATTERNS) {
        if (!pattern.test(line)) {
          continue;
        }
        // 反向验证用例中会出现形如 `src/modules/*/domain` 的示例，
        // 但它们不是机器路径；这里只关心盘符与家目录形态。
        offenders.push(`${file.relativePath}:${index + 1} 命中 ${pattern}`);
      }
    });
  }

  assert.deepEqual(offenders, [], `发现硬编码的机器绝对路径：\n${offenders.join('\n')}`);
});

test('架构依赖边界测试通过', async () => {
  const result = await runNpm(['run', 'test:unit']);

  assert.equal(result.code, 0, `npm run test:unit 应通过：\n${result.output}`);
});

test('环境门禁 env:check 仍全绿（无回归）', async () => {
  const result = await runNpm(['run', 'env:check']);

  assert.equal(result.code, 0, `env:check 应通过：\n${result.output}`);
});
