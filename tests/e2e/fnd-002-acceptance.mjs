/**
 * FND-002 验收脚本。
 *
 * 把任务验收标准固化为可复现的自动检查，而不是一次性的人工验证：
 *   1. `lint` / `format:check` / `typecheck` / `test` / `build` 等统一命令齐全可执行。
 *   2. ESLint 规则**真的会抓出违规**，而不是「跑通即算」——按规则族逐个验证。
 *   3. TypeScript 严格选项在位，且新增的 `exactOptionalPropertyTypes` 可反向验证。
 *   4. Prettier 能识别并修正未格式化内容，且格式化是幂等的。
 *   5. 正式文档与既有原型被排除在格式化范围之外。
 *   6. 所有工具产物落在项目内 `.cache/`，不污染项目根。
 *   7. 不存在 `ignoreBuildErrors` 这类「构建时放宽类型检查」的后门。
 *
 * 运行：npm run test:e2e
 *
 * 设计说明：
 * - ESLint 夹具通过 `--stdin --stdin-filename` 传入内存中的代码：既不在仓库里留夹具文件，
 *   又保证校验的是**项目实际生效的配置**，而不是为测试另建的一套配置。
 * - 需要落磁盘的临时产物只有两处：格式化检查写入 `.cache/`（已被 git 忽略），
 *   类型检查探针写入 `src/`（必须落在 tsconfig 的 include 范围内才有意义）。
 *   两者都在 `finally` 中清理。
 * - 本脚本不预先替 FND-003 选定 E2E 框架，只用 Node 内置能力与项目既有工具。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

import { resolveNpmInvocation } from '../../scripts/env/npm-command.mjs';
import { PATHS, PROJECT_ROOT, formatPath, isInside, projectEnv } from '../../scripts/env/paths.mjs';

/** 单条外部命令的最长等待时间，避免脚本在异常时无限挂起。 */
const COMMAND_TIMEOUT_MS = 180_000;

const nodeExecutable = (() => {
  const portable = path.join(
    PATHS.portableNode,
    process.platform === 'win32' ? 'node.exe' : 'bin/node',
  );
  return existsSync(portable) ? portable : process.execPath;
})();

const eslintBin = path.join(PROJECT_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');

const prettierBin = path.join(PROJECT_ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs');

const tscBin = path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** ESLint 警告级（对应 `--max-warnings=0` 会被判为失败的级别）。 */
const SEVERITY_WARNING = 1;

/** ESLint 错误级。 */
const SEVERITY_ERROR = 2;

/**
 * 类型检查探针文件。
 *
 * 它必须位于 tsconfig 的 `include` 范围内，项目真实的 `tsc` 才会检查它，
 * 因此只能写在 `src/` 下。脚本加载时与用例结束时各清理一次，
 * 避免上一次异常中断留下的探针污染项目的 lint 与 typecheck。
 */
const TYPECHECK_PROBE_FILE = path.join(PROJECT_ROOT, 'src', '__fnd002_type_probe__.ts');

/** 只在 `exactOptionalPropertyTypes` 开启时才会报错的代码。 */
const TYPECHECK_PROBE_SOURCE = [
  'interface ProbeOptions {',
  '  readonly retries?: number;',
  '}',
  '',
  'export const probeOptions: ProbeOptions = { retries: undefined };',
  '',
].join('\n');

/** 格式化/忽略范围相关用例使用的临时目录（位于被 git 忽略的 .cache 下）。 */
const FORMAT_PROBE_DIR = path.join(PATHS.cache, 'fnd-002-probe');

function removeTypecheckProbe() {
  rmSync(TYPECHECK_PROBE_FILE, { force: true });
}

removeTypecheckProbe();

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

/** 把 ESLint 结果压缩成一行，便于失败时定位。 */
function describeMessages(messages) {
  if (messages.length === 0) {
    return '(无)';
  }
  return messages
    .map((message) => `${message.ruleId ?? 'fatal'}@${message.line}:${message.column}`)
    .join(', ');
}

/**
 * 用项目实际生效的 ESLint 配置检查一段内存中的代码。
 *
 * @param {string} source 待检查代码。
 * @param {string} virtualPath 相对项目根的虚拟文件路径，决定套用哪一套规则。
 * @returns {Promise<{ exitCode: number | null, messages: readonly object[] }>}
 */
async function lintSnippet(source, virtualPath) {
  const result = await runNode(
    [eslintBin, '--stdin', '--stdin-filename', virtualPath, '--format', 'json'],
    { input: source },
  );

  if (result.stdout.trim() === '') {
    // 配置或插件出错时 ESLint 退出码非零且不产出 JSON。此时必须报出原始输出，
    // 否则会被误读成「代码合规、没有问题」——这正是最危险的假阳性。
    throw new Error(`ESLint 未产出结果（退出码 ${result.code}）：\n${result.output}`);
  }

  const reports = JSON.parse(result.stdout);
  const messages = reports.flatMap((report) => report.messages ?? []);
  return { exitCode: result.code, messages };
}

/** 用项目 Prettier 配置格式化一段代码并返回结果。 */
async function formatSnippet(source, virtualPath) {
  const result = await runNode([prettierBin, '--stdin-filepath', virtualPath], { input: source });

  assert.equal(result.code, 0, `Prettier 应成功格式化：\n${result.output}`);
  return result.stdout;
}

/** 断言指定规则确实被触发，并校验其严重级别。 */
function assertRuleFired(messages, ruleId, expectedSeverity) {
  const hit = messages.find((message) => message.ruleId === ruleId);

  assert.ok(hit, `期望 ESLint 报出 ${ruleId}，实际报出：${describeMessages(messages)}`);
  assert.equal(
    hit.severity,
    expectedSeverity,
    `${ruleId} 的严重级别应为 ${expectedSeverity}（1=警告，2=错误）`,
  );
  return hit;
}

test('统一命令齐全且覆盖 lint、format、typecheck、test、build', () => {
  const packageJson = JSON.parse(readFileSync(PATHS.packageJson, 'utf8'));
  const requiredCommands = [
    'dev',
    'build',
    'start',
    'lint',
    'lint:fix',
    'format',
    'format:check',
    'typecheck',
    'test',
    'test:unit',
    'test:e2e',
    'check',
  ];

  for (const command of requiredCommands) {
    assert.equal(
      typeof packageJson.scripts?.[command],
      'string',
      `package.json 缺少统一命令：${command}`,
    );
  }
});

test('TypeScript 严格选项在位，且未开启与 ESLint 重叠的检查', () => {
  const loaded = ts.readConfigFile(path.join(PROJECT_ROOT, 'tsconfig.json'), ts.sys.readFile);

  assert.equal(loaded.error, undefined, 'tsconfig.json 必须可被 TypeScript 解析');
  const options = loaded.config?.compilerOptions ?? {};

  const requiredStrictFlags = [
    'strict',
    'exactOptionalPropertyTypes',
    'noUncheckedIndexedAccess',
    'noImplicitOverride',
    'noImplicitReturns',
    'noFallthroughCasesInSwitch',
    'forceConsistentCasingInFileNames',
    'isolatedModules',
    'noEmit',
    'skipLibCheck',
  ];
  for (const flag of requiredStrictFlags) {
    assert.equal(options[flag], true, `tsconfig.json 应开启 ${flag}`);
  }

  // noUnusedLocals / noUnusedParameters 刻意交给 ESLint：两处同时开启会让同一个未使用变量
  // 报两遍，且会误伤 Next.js 路由签名等不得不存在的前置参数。
  for (const flag of ['noUnusedLocals', 'noUnusedParameters']) {
    assert.equal(
      options[flag],
      undefined,
      `tsconfig.json 不应开启 ${flag}（该职责已交给 ESLint 的 @typescript-eslint/no-unused-vars）`,
    );
  }
});

test('ESLint 抓出未使用变量（接手 tsconfig 已关闭的检查）', async () => {
  const source = ['const neverUsedValue = 1;', 'export const usedValue = 2;', ''].join('\n');

  const { messages } = await lintSnippet(source, 'src/__probe_unused__.ts');

  assertRuleFired(messages, '@typescript-eslint/no-unused-vars', SEVERITY_ERROR);
});

test('ESLint 抓出 React Hooks 违规', async () => {
  const source = [
    "import { useState } from 'react';",
    '',
    'export function Probe({ enabled }: { readonly enabled: boolean }) {',
    '  if (enabled) {',
    '    const [value] = useState(0);',
    '    return <span>{value}</span>;',
    '  }',
    '  return <span>off</span>;',
    '}',
    '',
  ].join('\n');

  const { messages } = await lintSnippet(source, 'app/__probe_hooks__.tsx');

  assertRuleFired(messages, 'react-hooks/rules-of-hooks', SEVERITY_ERROR);
});

test('ESLint 抓出缺少 key 的列表渲染', async () => {
  const source = [
    'export function Probe({ items }: { readonly items: readonly string[] }) {',
    '  return <ul>{items.map((item) => <li>{item}</li>)}</ul>;',
    '}',
    '',
  ].join('\n');

  const { messages } = await lintSnippet(source, 'app/__probe_key__.tsx');

  assertRuleFired(messages, 'react/jsx-key', SEVERITY_ERROR);
});

test('ESLint 抓出 JSX 无障碍问题，且 lint 把警告也视为失败', async () => {
  const source = ['export function Probe() {', '  return <img src="/probe.png" />;', '}', ''].join(
    '\n',
  );

  const { messages } = await lintSnippet(source, 'app/__probe_a11y__.tsx');

  // a11y 类规则在上游配置中是警告级：若不把警告当失败，这类规则在实际开发中形同虚设。
  assertRuleFired(messages, 'jsx-a11y/alt-text', SEVERITY_WARNING);

  const packageJson = JSON.parse(readFileSync(PATHS.packageJson, 'utf8'));
  assert.match(
    packageJson.scripts.lint,
    /--max-warnings=0/,
    'lint 必须把警告也视为失败，否则警告级规则不会被拦住',
  );
});

test('ESLint 对合规代码不报任何问题', async () => {
  const source = [
    "import { useState } from 'react';",
    '',
    'export function Probe({ items }: { readonly items: readonly string[] }) {',
    '  const [count, setCount] = useState(0);',
    '  return (',
    '    <ul>',
    '      {items.map((item) => (',
    '        <li key={item}>',
    '          {item}',
    '          <button type="button" onClick={() => setCount(count + 1)}>',
    '            {count}',
    '          </button>',
    '        </li>',
    '      ))}',
    '    </ul>',
    '  );',
    '}',
    '',
  ].join('\n');

  const { exitCode, messages } = await lintSnippet(source, 'app/__probe_clean__.tsx');

  assert.equal(exitCode, 0, `合规代码不应产生非零退出码，实际报出：${describeMessages(messages)}`);
  assert.equal(messages.length, 0, `合规代码不应产生问题，实际报出：${describeMessages(messages)}`);
});

test('Prettier 能规范未格式化代码，且格式化幂等', async () => {
  const messy = 'const probe={a:1,b:2}\nexport default probe\n';

  const once = await formatSnippet(messy, 'src/__probe_format__.ts');

  assert.notEqual(once, messy, 'Prettier 应改变未格式化的代码');
  assert.equal(
    once,
    'const probe = { a: 1, b: 2 };\nexport default probe;\n',
    '格式化结果应符合项目 Prettier 配置（单引号、分号、对象内空格、行尾换行）',
  );

  const twice = await formatSnippet(once, 'src/__probe_format__.ts');

  assert.equal(twice, once, '二次格式化不应再产生变化（幂等）');
});

test('格式化范围排除正式文档与既有原型', async () => {
  const ignoreText = readFileSync(path.join(PROJECT_ROOT, '.prettierignore'), 'utf8');

  assert.match(ignoreText, /^doc\/$/m, '.prettierignore 必须排除 doc/');
  assert.match(ignoreText, /^prototype\/$/m, '.prettierignore 必须排除 prototype/');

  // 仅靠配置文本不足以证明生效：这里让 Prettier 实际枚举一遍全仓库，
  // 确认它不会把正式文档与原型纳入格式化范围。
  const result = await runNode([prettierBin, '--list-different', '.']);
  const listed = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter((line) => line !== '');

  for (const protectedPrefix of ['doc/', 'prototype/']) {
    const offenders = listed.filter((line) => line.startsWith(protectedPrefix));
    assert.equal(
      offenders.length,
      0,
      `正式文档与既有原型不得进入格式化范围：${offenders.join(', ')}`,
    );
  }
});

test('格式化检查能识别未格式化文件，格式化后转为通过', async () => {
  const probeFile = path.join(FORMAT_PROBE_DIR, 'messy.ts');
  // Prettier 默认跳过 .prettierignore 命中的路径，而探测文件位于被忽略的 .cache/ 下。
  // 显式传入一个空忽略文件，把「本项目忽略了什么」从本用例中排除，只测检查行为本身。
  const emptyIgnoreFile = path.join(FORMAT_PROBE_DIR, 'empty.prettierignore');

  mkdirSync(FORMAT_PROBE_DIR, { recursive: true });
  writeFileSync(emptyIgnoreFile, '', 'utf8');
  writeFileSync(probeFile, 'const probe={a:1,b:2}\nexport default probe\n', 'utf8');

  try {
    const before = await runNode([
      prettierBin,
      '--check',
      '--ignore-path',
      emptyIgnoreFile,
      probeFile,
    ]);
    assert.notEqual(before.code, 0, '未格式化的文件应让 --check 以非零退出码结束');

    const write = await runNode([
      prettierBin,
      '--write',
      '--ignore-path',
      emptyIgnoreFile,
      probeFile,
    ]);
    assert.equal(write.code, 0, `格式化应成功：\n${write.output}`);

    const after = await runNode([
      prettierBin,
      '--check',
      '--ignore-path',
      emptyIgnoreFile,
      probeFile,
    ]);
    assert.equal(after.code, 0, `格式化后 --check 应通过：\n${after.output}`);
  } finally {
    rmSync(FORMAT_PROBE_DIR, { recursive: true, force: true });
  }
});

test('typecheck 在严格模式下通过', async () => {
  const result = await runNode([tscBin, '--noEmit']);

  assert.equal(result.code, 0, `tsc --noEmit 应通过：\n${result.output}`);
});

test('严格选项可反向验证：exactOptionalPropertyTypes 会拦住显式赋 undefined', async () => {
  try {
    writeFileSync(TYPECHECK_PROBE_FILE, TYPECHECK_PROBE_SOURCE, 'utf8');

    const result = await runNode([tscBin, '--noEmit']);

    assert.notEqual(
      result.code,
      0,
      '开启 exactOptionalPropertyTypes 后，给可选属性显式赋 undefined 必须编译失败',
    );
    assert.match(
      result.output,
      /__fnd002_type_probe__\.ts/,
      `错误应指向探针文件本身：\n${result.output}`,
    );
    // 断言报错原因正是该严格选项，而不是被某个无关问题碰巧触发。
    assert.match(
      result.output,
      /exactOptionalPropertyTypes/,
      `报错原因应是 exactOptionalPropertyTypes：\n${result.output}`,
    );
  } finally {
    removeTypecheckProbe();
  }
});

test('不存在放宽类型检查的构建后门', () => {
  const nextConfigText = readFileSync(path.join(PROJECT_ROOT, 'next.config.ts'), 'utf8');

  assert.ok(
    !/ignoreBuildErrors/.test(nextConfigText),
    'next.config.ts 不得通过 ignoreBuildErrors 让构建跳过 TypeScript 错误',
  );
});

test('工具产物全部落在项目内 .cache 目录', async () => {
  // 真实执行项目自己的命令，而不是假定调用方此前已经跑过它们；
  // 否则本用例会隐式依赖执行顺序，单独运行 test:e2e 时无法反映真实情况。
  const lintResult = await runNpm(['run', 'lint']);
  assert.equal(lintResult.code, 0, `npm run lint 应通过：\n${lintResult.output}`);

  const typecheckResult = await runNpm(['run', 'typecheck']);
  assert.equal(typecheckResult.code, 0, `npm run typecheck 应通过：\n${typecheckResult.output}`);

  const formatCheckResult = await runNpm(['run', 'format:check']);
  assert.equal(
    formatCheckResult.code,
    0,
    `npm run format:check 应通过（新代码可被统一格式化）：\n${formatCheckResult.output}`,
  );

  const artifacts = [
    path.join(PATHS.cache, 'eslint', '.eslintcache'),
    path.join(PATHS.cache, 'prettier', '.prettier-cache'),
    path.join(PATHS.cache, 'tsconfig.tsbuildinfo'),
  ];
  for (const artifact of artifacts) {
    assert.ok(isInside(PATHS.cache, artifact), `${formatPath(artifact)} 必须位于 .cache 目录内`);
    assert.ok(existsSync(artifact), `工具产物应已生成：${formatPath(artifact)}`);
  }

  // 产物不得落到项目根，否则会污染仓库根目录并容易误提交。
  for (const stray of ['tsconfig.tsbuildinfo', '.eslintcache', '.prettier-cache']) {
    assert.ok(!existsSync(path.join(PROJECT_ROOT, stray)), `项目根不应出现工具产物：${stray}`);
  }
});

test('环境门禁 env:check 仍全绿（无回归）', async () => {
  const result = await runNpm(['run', 'env:check']);

  assert.equal(result.code, 0, `env:check 应通过：\n${result.output}`);
});
