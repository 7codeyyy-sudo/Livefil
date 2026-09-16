/**
 * FND-007 验收：提交前检查（husky + lint-staged）。
 *
 * 分两层，缺一不可：
 *
 * 1. **静态断言**——钩子存在且只是一行转发、配置里只允许出现格式化与自动修复、
 *    生成物没有被误提交。这一层证明「接线接对了」。
 * 2. **行为断言**——在 `.runtime/probes/<唯一目录>/` 下建一个**自包含的 git 沙箱**，
 *    装好钩子后跑**真实的 `git commit`**。这一层证明「接线真的生效」。
 *
 * 为什么必须有第 2 层：只断言配置文件里写了什么，无法证明提交时钩子真的拦住了东西。
 * 「约束只在测试里成立，就等于没成立」——这是 FND-005 审查留下的教训。
 *
 * 为什么沙箱是**拷贝**而不是直接在主仓里试：
 *   - 钩子里的 `scripts/env/npm.mjs` 按**自身所在位置**向上解析 PROJECT_ROOT，
 *     所以沙箱必须自带 `scripts/` 与项目根标记文件 `doc/README.md`，
 *     缺任何一个，npm.mjs 启动即抛「无法定位项目根目录」。
 *   - 也正因为 `scripts/` 是拷贝而非联接，沙箱才拥有自己的 PROJECT_ROOT，
 *     提交只会作用于沙箱的暂存区。
 *   - 主仓永不产生提交、暂存区永不被扰动。
 *
 * 沙箱的三处联接（`node_modules`、`.runtime/node`，均为只读依赖）**删除时必须先删
 * 联接本身**：直接递归删除会顺着联接进去清空主仓的真实依赖。脚本在清理后断言主仓
 * `node_modules/next` 仍在。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { PATHS, PROJECT_ROOT, formatPath, isInside, projectEnv } from '../../scripts/env/paths.mjs';

/** 单条外部命令的最长等待时间。沙箱里的提交要跑 npm + lint-staged + prettier + eslint。 */
const COMMAND_TIMEOUT_MS = 300_000;

/** 探针根目录。位于 `.runtime/` 内，已被 gitignore，且不属任何工具的扫描范围。 */
const PROBE_ROOT = path.join(PATHS.runtime, 'probes');

const HOOK_FILE = path.join(PROJECT_ROOT, '.husky', 'pre-commit');
const LINT_STAGED_CONFIG = path.join(PROJECT_ROOT, 'lint-staged.config.mjs');
const PRETTIER_IGNORE = path.join(PROJECT_ROOT, '.prettierignore');

/** 钩子唯一允许的一行（注释之外）。转发给 npm.mjs 以保证 Node 选择与全项目同源。 */
const EXPECTED_HOOK_COMMAND = 'node scripts/env/npm.mjs run lint:staged';

/** 便携 Node 可执行文件；CI 上不存在，此时回退到当前进程的 Node。 */
const PORTABLE_NODE_EXECUTABLE = path.join(
  PATHS.portableNode,
  process.platform === 'win32' ? 'node.exe' : 'bin/node',
);

/** 需要拷进沙箱才能让 `npm.mjs` 与两个工具自行定位配置的文件。 */
const SANDBOX_FILES = [
  'package.json',
  'eslint.config.mjs',
  'lint-staged.config.mjs',
  '.prettierrc.json',
  '.prettierignore',
  '.gitignore',
];

/** 需要拷进沙箱的目录（`scripts/env` 是 npm.mjs 的宿主，必须自带）。 */
const SANDBOX_DIRECTORIES = [path.join('scripts', 'env'), '.husky'];

/** 沙箱内需要建好的目录。`doc` 只为承载项目根标记文件。 */
const SANDBOX_DIRECTORIES_TO_CREATE = ['src/probe', 'doc'];

/**
 * 项目根标记文件。`paths.mjs` 靠它向上解析 PROJECT_ROOT，
 * 沙箱里少了它，`npm.mjs` 会直接失败——这是最容易漏掉的一项。
 */
const ROOT_MARKER_RELATIVE = path.join('doc', 'README.md');

/** 刻意与 Prettier 风格冲突的源码：双引号、缺分号、多余空格、超长行。 */
const MISFORMATTED_SOURCE = [
  'const   probeValue={answer:42,note:"FND-007 探针：这段内容故意不符合 Prettier 风格"}',
  'export function probeValueOf(){return probeValue}',
  '',
].join('\n');

/** 刻意与 Prettier 风格冲突的 Markdown：标题多空格、列表符用 `*`。 */
const MISFORMATTED_MARKDOWN = ['#    探针标题', '', '', '*   第一项', '*   第二项', ''].join('\n');

/** 触发 `no-console` 的源码。`src/**` 下禁止直接使用 console，且该规则不可自动修复。 */
const CONSOLE_SOURCE = [
  'export function probeConsole(): void {',
  "  console.log('FND-007 探针：这条语句用于验证钩子会阻断提交');",
  '}',
  '',
].join('\n');

/**
 * git 的公共参数。
 *
 * 身份与签名**不能**只靠这里传 `-c`——见 `configureRepository()`：
 * lint-staged 在备份阶段会自己起一条 `git stash`，那条命令继承不到本数组。
 */
const GIT_BASE_ARGS = [];

/** 本次运行的沙箱根（唯一目录，由 mkdtemp 保证不重名）。 */
let runRoot;

after(() => {
  removeRunRoot();
});

test('钩子文件就位，且只做一次转发', () => {
  assert.ok(existsSync(HOOK_FILE), `缺少钩子文件：${formatPath(HOOK_FILE)}`);

  const source = readFileSync(HOOK_FILE, 'utf8');

  // 只对**可执行语句**做判定：注释里提到 `npx` 是为了解释「为什么不用它」，
  // 把它一并判为违规会让「解释性注释」与「真的用了它」无法区分。
  const codeLines = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const code = codeLines.join('\n');

  assert.deepEqual(
    codeLines,
    [EXPECTED_HOOK_COMMAND],
    '钩子应当只有一行可执行语句，且必须转发给 npm.mjs（Node 选择策略与全项目同源）',
  );

  // 钩子由 git 以「仓库根为 cwd」执行，因此不需要、也不允许出现绝对路径。
  assert.ok(
    !/(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]/.test(code) && !/\/(?:Users|home)\//.test(code),
    '钩子不得包含本机绝对路径',
  );
  assert.ok(!/\bnpx\b/.test(code), '钩子不得用 npx：那会绕过项目的 Node 选择与本地依赖');
  assert.ok(
    !code.includes('husky.sh'),
    '钩子不得 source `.husky/_/husky.sh`：husky 9 里它只剩一条「v10 会失败」的弃用告警',
  );
});

test('lint-staged 配置只含格式化与自动修复', async () => {
  // 动态 import 真实配置模块，而不是对配置文件做关键词匹配。
  // 两个理由：① 注释里解释「为什么不跑 typecheck」「为什么不用 --max-warnings」
  // 是必要的文档，文本匹配会把解释本身判成违规；② 只有求值真实配置，
  // 才能发现「结构被改坏但文字仍在」这类改动。
  const configModule = await import(pathToFileURL(LINT_STAGED_CONFIG).href);
  const config = configModule.default;

  assert.ok(config && typeof config === 'object', 'lint-staged 配置应当默认导出对象');

  const entries = Object.entries(config);
  assert.ok(entries.length > 0, 'lint-staged 配置不得为空');

  const commands = entries.flatMap(([, value]) => (Array.isArray(value) ? value : [value]));
  for (const command of commands) {
    assert.equal(typeof command, 'string', '任务命令必须是字符串');
  }
  const allCommands = commands.join(' && ');

  // 任务清单明确要求：pre-commit 不执行完整 typecheck、test 和 build。
  for (const forbidden of [
    'typecheck',
    'tsc',
    'next build',
    'test:unit',
    'test:e2e',
    'playwright',
    'vitest',
  ]) {
    assert.ok(
      !allCommands.includes(forbidden),
      `提交前检查不得执行 ${forbidden}：必须秒级返回，完整门禁由 CI 负责`,
    );
  }

  // 分层：钩子只拦 error；零警告政策的唯一闸门是 CI 的全仓 lint。
  assert.ok(
    !allCommands.includes('--max-warnings'),
    '不得出现 --max-warnings：单文件子集与全仓结果不等价，零警告由 CI 把关',
  );

  const codeEntry = entries.find(([, value]) =>
    (Array.isArray(value) ? value : [value]).some(
      (command) => typeof command === 'string' && command.includes('eslint'),
    ),
  );
  assert.ok(codeEntry, '应当有一条针对代码文件、执行 ESLint 的任务');

  const [, codeTasks] = codeEntry;
  assert.ok(Array.isArray(codeTasks), '代码文件的任务应写成数组以固定执行顺序');
  assert.deepEqual(
    codeTasks,
    ['eslint --fix --no-warn-ignored', 'prettier --write'],
    '顺序应为：ESLint 自动修复 → Prettier 最终定版式',
  );

  // `doc/` 的豁免只能有一个来源，否则两处清单必然漂移。
  assert.ok(
    readFileSync(PRETTIER_IGNORE, 'utf8').includes('doc/'),
    '`.prettierignore` 必须忽略 doc/：这是「不自动格式化正式文档」的唯一来源',
  );
});

test('依赖登记与生成物忽略就位', () => {
  const packageJson = JSON.parse(readFileSync(PATHS.packageJson, 'utf8'));

  assert.equal(packageJson.scripts.prepare, 'husky', 'prepare 脚本必须是 husky（安装即装钩子）');
  assert.equal(
    packageJson.scripts['lint:staged'],
    'lint-staged',
    '需提供 lint:staged 脚本供钩子调用',
  );

  for (const dependency of ['husky', 'lint-staged']) {
    const version = packageJson.devDependencies?.[dependency];
    assert.ok(version, `${dependency} 必须在 devDependencies 中并锁定版本`);
    assert.match(version, /^\d+\.\d+\.\d+$/, `${dependency} 必须是精确版本（--save-exact）`);
  }

  const lock = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package-lock.json'), 'utf8'));
  for (const dependency of ['husky', 'lint-staged']) {
    assert.ok(lock.packages?.[`node_modules/${dependency}`], `锁文件中缺少 ${dependency} 条目`);
  }

  // husky 生成的引导层必须被忽略——否则每次安装都会在提交里带上生成物。
  const gitIgnore = readFileSync(PATHS.gitIgnore, 'utf8');
  assert.ok(gitIgnore.includes('.husky/_/'), '根 .gitignore 应显式声明忽略 .husky/_/');
});

test('真实提交：已暂存文件被修复并重新入暂存，其余文件零改动', async () => {
  const sandbox = createSandbox();

  try {
    await initializeRepository(sandbox);
    await installHooks(sandbox);
    await commitScaffolding(sandbox);

    const formatted = path.join(sandbox, 'src', 'probe', 'needs-format.ts');
    const untouched = path.join(sandbox, 'src', 'probe', 'untouched.ts');
    const document = path.join(sandbox, 'doc', 'probe-doc.md');

    writeFileSync(formatted, MISFORMATTED_SOURCE, 'utf8');
    writeFileSync(untouched, MISFORMATTED_SOURCE, 'utf8');
    writeFileSync(document, MISFORMATTED_MARKDOWN, 'utf8');

    // 前提校验：证明 Markdown 样本在「未被忽略」时确实会被 Prettier 改写。
    // 少了这一步，「doc/ 下的文件没被改动」就可能是个永远为真的空断言。
    const premise = await runPrettierIgnoringNothing(sandbox, path.join('doc', 'probe-doc.md'));
    assert.notEqual(premise.code, 0, 'Markdown 样本必须先被证明「本应被格式化」，否则该用例无效');

    await git(sandbox, ['add', 'src/probe/needs-format.ts', 'doc/probe-doc.md']);

    const before = await git(sandbox, ['rev-parse', 'HEAD']);
    const commit = await gitCommit(sandbox, '探针：已暂存文件应被自动格式化');

    assert.equal(commit.code, 0, `提交应当成功：\n${commit.output}`);

    const after_ = await git(sandbox, ['rev-parse', 'HEAD']);
    assert.notEqual(after_.stdout.trim(), before.stdout.trim(), '应当产生了一个新提交');

    // ① 已暂存文件被修复，且修复结果被自动重新加入暂存区。
    const committed = await git(sandbox, ['show', 'HEAD:src/probe/needs-format.ts']);
    assert.notEqual(committed.stdout, MISFORMATTED_SOURCE, '已暂存源码应当在提交前被自动格式化');
    assert.ok(committed.stdout.includes("'FND-007 探针"), '格式化应把双引号改为单引号');

    const status = await git(sandbox, ['status', '--porcelain', 'src/probe/needs-format.ts']);
    assert.equal(
      status.stdout.trim(),
      '',
      '被修复的文件不得留下未暂存差异——修复结果必须被自动重新加入暂存区',
    );

    // ② `doc/` 下的正式文档不被自动格式化。
    assert.equal(
      readFileSync(document, 'utf8'),
      MISFORMATTED_MARKDOWN,
      'doc/ 下的文件不得被提交前检查改写（豁免来自 .prettierignore）',
    );

    // ③ 未被暂存的文件逐字节不动。
    assert.equal(
      readFileSync(untouched, 'utf8'),
      MISFORMATTED_SOURCE,
      '未暂存文件不得被提交前检查改动',
    );

    // ④ 部分暂存的文件：工作区里未暂存的那部分改动必须被原样还原。
    const partial = path.join(sandbox, 'src', 'probe', 'partial.ts');
    writeFileSync(partial, 'export const partial = 1;\n', 'utf8');
    await git(sandbox, ['add', 'src/probe/partial.ts']);
    const workingCopy = `${MISFORMATTED_SOURCE}\nexport const partialStaged = partial;\n`;
    writeFileSync(partial, workingCopy, 'utf8');

    const partialCommit = await gitCommit(sandbox, '探针：部分暂存文件');
    assert.equal(partialCommit.code, 0, `部分暂存场景的提交应当成功：\n${partialCommit.output}`);
    assert.equal(
      readFileSync(partial, 'utf8'),
      workingCopy,
      '部分暂存文件在提交后，工作区里未暂存的那部分改动必须原样保留',
    );

    // ⑤ 无暂存改动时钩子不应失败（空数据路径），且重复执行幂等。
    const emptyFirst = await gitCommit(sandbox, '探针：无暂存改动');
    const emptySecond = await gitCommit(sandbox, '探针：重复执行');
    assert.equal(emptyFirst.code, 0, `无暂存改动时钩子仍应成功：\n${emptyFirst.output}`);
    assert.equal(emptySecond.code, 0, `重复执行应当幂等：\n${emptySecond.output}`);

    // ⑥ 不可自动修复的 ESLint 错误必须阻断提交。
    const beforeReject = await git(sandbox, ['rev-parse', 'HEAD']);
    const consoleProbe = path.join(sandbox, 'src', 'probe', 'console-call.ts');
    writeFileSync(consoleProbe, CONSOLE_SOURCE, 'utf8');
    await git(sandbox, ['add', 'src/probe/console-call.ts']);

    const rejected = await gitCommit(sandbox, '探针：这条提交必须被钩子阻止');
    assert.notEqual(rejected.code, 0, '存在 ESLint error 时提交必须失败');
    assert.match(
      rejected.output,
      /no-console/,
      `失败输出应当指出具体规则（no-console）：\n${rejected.output}`,
    );

    const afterReject = await git(sandbox, ['rev-parse', 'HEAD']);
    assert.equal(
      afterReject.stdout.trim(),
      beforeReject.stdout.trim(),
      '被阻断的提交不得真的产生提交对象',
    );
  } finally {
    removeRunRoot();
  }
});

/**
 * 建立自包含沙箱：拷贝配置与工具脚本，联接只读依赖。
 *
 * @returns {string} 沙箱仓库的绝对路径。
 */
function createSandbox() {
  mkdirSync(PROBE_ROOT, { recursive: true });
  runRoot = mkdtempSync(path.join(PROBE_ROOT, 'fnd-007-'));
  const sandbox = path.join(runRoot, 'repo');
  mkdirSync(sandbox, { recursive: true });

  // 防御性断言：任何后续删除都必须落在这个目录内。
  assert.ok(isInside(PROJECT_ROOT, sandbox), '沙箱必须位于项目目录内');

  for (const file of SANDBOX_FILES) {
    cpSync(path.join(PROJECT_ROOT, file), path.join(sandbox, file), { recursive: true });
  }
  for (const directory of SANDBOX_DIRECTORIES) {
    cpSync(path.join(PROJECT_ROOT, directory), path.join(sandbox, directory), { recursive: true });
  }
  for (const directory of SANDBOX_DIRECTORIES_TO_CREATE) {
    mkdirSync(path.join(sandbox, directory), { recursive: true });
  }

  // 项目根标记文件：`paths.mjs` 靠它解析 PROJECT_ROOT，缺失会让 npm.mjs 直接失败。
  cpSync(path.join(PROJECT_ROOT, ROOT_MARKER_RELATIVE), path.join(sandbox, ROOT_MARKER_RELATIVE));

  linkDependency(path.join(PROJECT_ROOT, 'node_modules'), path.join(sandbox, 'node_modules'));
  if (existsSync(PORTABLE_NODE_EXECUTABLE)) {
    mkdirSync(path.join(sandbox, '.runtime'), { recursive: true });
    linkDependency(PATHS.portableNode, path.join(sandbox, '.runtime', 'node'));
  }

  return sandbox;
}

/**
 * 建立目录联接（Windows junction / POSIX symlink），避免拷贝整个依赖树。
 *
 * @param {string} target 真实目录。
 * @param {string} linkPath 联接路径。
 */
function linkDependency(target, linkPath) {
  mkdirSync(path.dirname(linkPath), { recursive: true });
  // 用 fs.symlinkSync 而不是 shell 调 mklink：类型 'junction' 在 Windows 上不需要
  // 管理员权限，在 POSIX 上按普通目录符号链接处理。
  symlinkSync(target, linkPath, 'junction');
}

/** 初始化沙箱仓库。 */
async function initializeRepository(sandbox) {
  const init = await git(sandbox, ['init']);
  assert.equal(init.code, 0, `git init 失败：\n${init.output}`);

  await configureRepository(sandbox);
  await assertSandboxRepository(sandbox);
}

/**
 * 断言「git 站在沙箱里」——本脚本最重要的一道安全护栏。
 *
 * 为什么必须有：如果沙箱的 `.git` 因为任何原因不存在，git 会**静默向上找到主仓**，
 * 于是 `git add -A` / `git commit` 会作用到项目本身，甚至改坏主仓的 `.git`。
 * 这不是假设——2026-09-16 在受限沙箱环境中确实发生过一次（嵌套仓库消失 → 命令落到主仓）。
 *
 * 双保险：
 *   1. `GIT_CEILING_DIRECTORIES`（见 `sandboxEnv`）从机制上禁止 git 向上越过沙箱；
 *   2. 这里再断言解析出的仓库根确实是沙箱本身，把「越界」变成一条可读的失败信息。
 *
 * @param {string} sandbox 沙箱路径。
 */
async function assertSandboxRepository(sandbox) {
  assert.ok(
    existsSync(path.join(sandbox, '.git')),
    `沙箱内缺少 .git（${formatPath(sandbox)}）——环境丢弃了嵌套仓库，拒绝继续`,
  );

  const toplevel = await git(sandbox, ['rev-parse', '--show-toplevel']);
  assert.equal(
    toplevel.code,
    0,
    '沙箱不是可用的 git 仓库。若在受限沙箱/容器中运行本脚本，请改在本机终端执行：' +
      `\n${toplevel.output}`,
  );
  assert.equal(
    path.resolve(toplevel.stdout.trim()).toLowerCase(),
    path.resolve(sandbox).toLowerCase(),
    'git 解析出的仓库根必须是沙箱本身——否则后续命令会作用到主仓',
  );
}

/**
 * 把身份、签名与换行策略写进**沙箱仓库的本地配置**。
 *
 * 为什么不能只在调用 `git commit` 时用 `-c` 传：
 * lint-staged 在备份阶段会自己起一条 `git stash`（它也是一个提交对象），
 * 那条命令继承不到我们在命令行上给的 `-c`。沙箱里缺身份时，lint-staged 会以
 * 「Failed to back up original state」失败——症状看起来像 lint-staged 的 bug，
 * 实际是 git 身份缺失。
 *
 * 这些配置只写进沙箱的 `.git/config`（一次性目录），**不触碰任何全局配置**。
 * 邮箱用保留域，避免把真实邮箱写进测试产物。
 */
async function configureRepository(sandbox) {
  const settings = [
    ['user.name', 'FND-007 验收'],
    ['user.email', 'fnd-007@example.com'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ];

  for (const [key, value] of settings) {
    const result = await git(sandbox, ['config', key, value]);
    assert.equal(result.code, 0, `设置 ${key} 失败：\n${result.output}`);
  }
}

/**
 * 在沙箱内安装钩子——与 package.json 的 `prepare` 走同一条路径。
 *
 * 必须对沙箱单独执行一次：husky 是按当前工作目录里的 `.git` 与 `.husky/` 安装的，
 * 主仓的安装结果不会自动延伸到沙箱。
 */
async function installHooks(sandbox) {
  const result = await runCommand(
    process.execPath,
    [path.join(sandbox, 'node_modules', 'husky', 'bin.js')],
    { cwd: sandbox, env: sandboxEnv(sandbox) },
  );
  assert.equal(result.code, 0, `husky 安装失败：\n${result.output}`);

  const hooksPath = await git(sandbox, ['config', 'core.hooksPath']);
  assert.equal(hooksPath.stdout.trim(), '.husky/_', 'husky 应当把 core.hooksPath 指向 .husky/_');
  assert.ok(
    existsSync(path.join(sandbox, '.husky', '_', 'pre-commit')),
    'husky 应当生成 .husky/_/pre-commit 引导脚本',
  );
}

/**
 * 先把沙箱脚手架本身提交掉。
 *
 * 两个作用：① 让后续「暂存区干净」这类断言不被这些未跟踪的配置副本干扰；
 * ② 顺带验证钩子在一批真实的配置文件上也能通过（它们本来就是规范化的），
 * 也就是「钩子不会无差别地拦下正常提交」。
 */
async function commitScaffolding(sandbox) {
  await assertSandboxRepository(sandbox);

  const added = await git(sandbox, ['add', '-A']);
  assert.equal(added.code, 0, `暂存脚手架失败：\n${added.output}`);

  const commit = await gitCommit(sandbox, '初始化：提交前检查沙箱脚手架');
  assert.equal(commit.code, 0, `脚手架提交应当成功：\n${commit.output}`);
}

/**
 * 用「空忽略清单」跑一次 Prettier，检验样本本身是否确实需要被格式化。
 *
 * @param {string} sandbox 沙箱路径。
 * @param {string} relativeFile 沙箱内相对路径。
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, output: string }>}
 */
async function runPrettierIgnoringNothing(sandbox, relativeFile) {
  const emptyIgnore = path.join(runRoot, 'prettier-empty-ignore');
  writeFileSync(emptyIgnore, '', 'utf8');
  return runCommand(
    process.execPath,
    [
      path.join(PROJECT_ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs'),
      '--check',
      '--ignore-path',
      emptyIgnore,
      relativeFile,
    ],
    { cwd: sandbox },
  );
}

/** 在沙箱内执行一条 git 命令。 */
function git(sandbox, args) {
  return runCommand('git', [...GIT_BASE_ARGS, ...args], {
    cwd: sandbox,
    env: sandboxEnv(sandbox),
  });
}

/** 在沙箱内提交（`--allow-empty` 让「无暂存改动」也成为可测路径）。 */
async function gitCommit(sandbox, message) {
  // 每次提交前都重新确认「git 站在沙箱里」：沙箱仓库若中途消失，
  // 这一条会把上一次事故那样的越界操作拦在提交之前。
  await assertSandboxRepository(sandbox);
  return git(sandbox, ['commit', '--allow-empty', '-m', message]);
}

/** 删除本次运行的沙箱。先解联接，再删实体，最后断言主仓依赖完好。 */
function removeRunRoot() {
  if (!runRoot) {
    return;
  }
  const root = runRoot;
  runRoot = undefined;

  if (!isInside(PROBE_ROOT, root)) {
    // 宁可不清理，也不能删到项目其它地方。
    console.error(`[fnd-007] 拒绝清理项目外路径：${root}`);
    return;
  }

  for (const link of ['repo/node_modules', 'repo/.runtime/node']) {
    unlinkDirectoryLink(path.join(root, link));
  }

  rmSync(root, { recursive: true, force: true });
  assert.ok(
    existsSync(path.join(PROJECT_ROOT, 'node_modules', 'next')),
    '清理沙箱后主仓 node_modules 必须完好（联接只能解链接，不能递归删除）',
  );
}

/**
 * 解除一个目录联接。
 *
 * 必须用非递归的 rmdir：递归删除会**顺着联接**清空目标目录，
 * 也就是把主仓真实的 node_modules 删掉。
 *
 * @param {string} linkPath 联接路径。
 */
function unlinkDirectoryLink(linkPath) {
  if (!existsSync(linkPath)) {
    return;
  }
  rmdirSync(linkPath);
}

/**
 * 执行一条命令并收集输出。
 *
 * @param {string} command 可执行文件。
 * @param {readonly string[]} args 参数。
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options] 可选参数。
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, output: string }>}
 */
function runCommand(command, args, options = {}) {
  const { cwd = PROJECT_ROOT, env = projectEnv(), timeoutMs = COMMAND_TIMEOUT_MS } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

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
      reject(
        new Error(`命令超时（${timeoutMs}ms）：${command} ${args.join(' ')}\n${stdout}${stderr}`),
      );
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, output: `${stdout}${stderr}` });
    });
  });
}

/**
 * 子进程环境：把项目锁定的 Node 目录前置进 PATH，并给 git 设一道「天花板」。
 *
 * `GIT_CEILING_DIRECTORIES` 是这里最关键的一项：它限定 git 向上查找仓库时**不得越过沙箱**。
 * 少了它就等于把安全寄托在「沙箱的 .git 一定存在」上——而 2026-09-16 的实测表明，
 * 在受限沙箱环境里嵌套仓库会消失，git 随即静默向上找到主仓，`git add -A` 与 `git commit`
 * 就作用到了项目本身。有了天花板，同样情形只会得到一句 `not a git repository` 并立即失败。
 *
 * @param {string} sandbox 沙箱路径。
 * @returns {NodeJS.ProcessEnv} 子进程环境。
 */
function sandboxEnv(sandbox) {
  const baseEnv = projectEnv();
  const nodeDirectory = existsSync(PORTABLE_NODE_EXECUTABLE)
    ? path.dirname(PORTABLE_NODE_EXECUTABLE)
    : path.dirname(process.execPath);
  const inheritedPath = baseEnv.PATH ?? baseEnv.Path ?? '';

  return {
    ...baseEnv,
    GIT_CEILING_DIRECTORIES: sandbox,
    PATH: [nodeDirectory, inheritedPath].filter((segment) => segment !== '').join(path.delimiter),
  };
}
