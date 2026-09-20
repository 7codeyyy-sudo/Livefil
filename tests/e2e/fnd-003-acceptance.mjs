/**
 * FND-003 验收脚本。
 *
 * 把任务验收标准固化为可复现的自动检查，而不是一次性的人工验证：
 *   1. 单元 / 集成 / E2E 三层测试的配置与目录齐备。
 *   2. 三层之间**文件模式互不重叠**（`*.test.ts(x)` 归 Vitest，`*.spec.ts` 归 Playwright）。
 *   3. FND-002 固化的统一命令未被破坏，且 `test:unit` 已切换到新运行器。
 *   4. 既有单元测试完成迁移，仓库里不存在两套并存且互相矛盾的运行器。
 *   5. 测试数据工厂可运行，「随机测试用户」确实产出保留域邮箱。
 *   6. 浏览器安装目录与所有测试产物都固定在项目内，不写入用户目录或项目根。
 *   7. 验收标准：单元测试、API 测试、页面 E2E 用例三者齐备。
 *
 * 运行：npm run test:e2e
 *
 * 关于范围：页面 E2E 的**实际浏览器执行**不放在本脚本内。
 * 它需要先构建再启动服务器（分钟级），把它塞进 `test:e2e` 会让每次
 * `npm run check` 都付出这个代价。因此本脚本验证 E2E 用例与配置的正确性，
 * 实际执行由 `npm run test:browser` 承担，并由 `npm run check:all` 串联。
 *
 * 关于重复：本脚本自带一份命令执行辅助，而没有抽取成共享模块。
 * 既有 fnd-001 / fnd-002 验收脚本同样各自持有一份——每份验收脚本自成一体、
 * 可单独审阅与单独运行，这个好处大于少写十几行的收益。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { resolveNpmInvocation } from '../../scripts/env/npm-command.mjs';
import { PATHS, PROJECT_ROOT, formatPath, projectEnv } from '../../scripts/env/paths.mjs';

/** 单条外部命令的最长等待时间，避免脚本在异常时无限挂起。 */
const COMMAND_TIMEOUT_MS = 300_000;

const VITEST_CONFIG = path.join(PROJECT_ROOT, 'vitest.config.mts');
const PLAYWRIGHT_CONFIG = path.join(PROJECT_ROOT, 'playwright.config.ts');
const PLAYWRIGHT_WRAPPER = path.join(PROJECT_ROOT, 'scripts', 'env', 'playwright.mjs');

/**
 * Playwright 内部注册表实现文件。
 *
 * 用于锁定其环境变量契约：注册表目录取自 `process.env.PWTEST_SERVER_REGISTRY`，
 * 该变量属内部实现而非公开配置，上游改名或移除时不会有任何运行时报错，
 * 只会让包装器里的注入变成空操作并静默退回用户目录。
 */
const PLAYWRIGHT_SERVER_REGISTRY_SOURCE = path.join(
  PROJECT_ROOT,
  'node_modules',
  'playwright-core',
  'lib',
  'serverRegistry.js',
);
const VITEST_SETUP = path.join(PROJECT_ROOT, 'tests', 'setup', 'vitest.setup.ts');
const MSW_SERVER = path.join(PROJECT_ROOT, 'tests', 'setup', 'msw-server.ts');
const FACTORIES_ENTRY = path.join(PROJECT_ROOT, 'tests', 'factories', 'index.ts');
const CLEANUP_HELPER = path.join(PROJECT_ROOT, 'tests', 'helpers', 'cleanup.ts');
const MIGRATED_UNIT_TEST = path.join(PROJECT_ROOT, 'tests', 'unit', 'validation', 'env.test.ts');
const E2E_SPEC = path.join(PROJECT_ROOT, 'tests', 'e2e', 'home.spec.ts');

/** 接口文档。API 表面的唯一登记处。 */
const API_DOC = path.join(PROJECT_ROOT, 'doc', '05-technical-design', '接口文档.md');

/** Next.js App Router 的 API 根目录。 */
const API_ROUTES_DIR = path.join(PROJECT_ROOT, 'app', 'api');

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
 * 读取项目内文件；缺失时给出可读的失败信息而不是抛出 ENOENT。
 *
 * @param {string} absolutePath 目标文件的绝对路径。
 * @returns {string} 文件内容。
 */
function readProjectFile(absolutePath) {
  assert.ok(existsSync(absolutePath), `缺少文件：${formatPath(absolutePath)}`);
  return readFileSync(absolutePath, 'utf8');
}

/** 读取并解析 package.json。 */
function readPackageJson() {
  return JSON.parse(readProjectFile(PATHS.packageJson));
}

/**
 * 枚举 `app/api` 下的所有路由路径。
 *
 * @param apiDir API 根目录。
 * @param segments 递归累积的目录片段。
 * @returns 以 `/` 开头的业务路由路径（已去掉 `v1` 这类版本前缀）。
 */
function collectApiRoutes(apiDir, segments = []) {
  const routes = [];

  for (const entry of readdirSync(apiDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      routes.push(...collectApiRoutes(path.join(apiDir, entry.name), [...segments, entry.name]));
      continue;
    }

    if (entry.name === 'route.ts' || entry.name === 'route.tsx') {
      // 去掉版本前缀：接口文档按业务域组织，写的是 `/health` 而不是 `/v1/health`。
      const businessSegments = segments.filter((segment) => !/^v\d+$/.test(segment));
      routes.push(`/${businessSegments.join('/')}`);
    }
  }

  return routes;
}

test('单元、集成与 E2E 三层的配置和目录齐备', () => {
  const requiredFiles = [
    VITEST_CONFIG,
    PLAYWRIGHT_CONFIG,
    VITEST_SETUP,
    MSW_SERVER,
    FACTORIES_ENTRY,
    CLEANUP_HELPER,
    MIGRATED_UNIT_TEST,
    E2E_SPEC,
  ];

  for (const required of requiredFiles) {
    assert.ok(existsSync(required), `缺少测试基础设施文件：${formatPath(required)}`);
  }
});

test('Vitest 按环境分离 unit 与 integration', () => {
  const vitestConfig = readProjectFile(VITEST_CONFIG);

  assert.match(vitestConfig, /name:\s*'unit'/, 'vitest 配置应声明 unit project');
  assert.match(vitestConfig, /name:\s*'integration'/, 'vitest 配置应声明 integration project');

  // 环境分离的意义：纯逻辑测试不应获得浏览器全局，否则「本该是纯函数」的代码
  // 会悄悄依赖 DOM 而不被发现。
  assert.match(vitestConfig, /environment:\s*'node'/, 'unit project 应运行在 node 环境');
  assert.match(vitestConfig, /environment:\s*'jsdom'/, 'integration project 应运行在 jsdom 环境');
});

test('Vitest 与 Playwright 的文件模式互不重叠', () => {
  const vitestConfig = readProjectFile(VITEST_CONFIG);
  const playwrightConfig = readProjectFile(PLAYWRIGHT_CONFIG);

  // 只在 `projects` 段内寻找 include：`coverage.include` 用的是同一个键名，
  // 不限定范围就会把覆盖率配置误判成测试文件模式。
  const projectsStart = vitestConfig.indexOf('projects:');
  const coverageStart = vitestConfig.indexOf('coverage:', projectsStart);

  assert.ok(projectsStart >= 0, 'vitest 配置应声明 projects');
  assert.ok(coverageStart > projectsStart, 'vitest 配置应在 projects 之后声明 coverage');

  const projectsBlock = vitestConfig.slice(projectsStart, coverageStart);
  const includeBlocks = [...projectsBlock.matchAll(/include:\s*\[([^\]]*)\]/g)].map(
    (match) => match[1],
  );

  assert.equal(
    includeBlocks.length,
    2,
    `unit 与 integration 应各声明一份 include，实际找到 ${includeBlocks.length} 份`,
  );

  for (const block of includeBlocks) {
    assert.ok(
      !block.includes('.spec.'),
      `vitest 的 include 不得覆盖 *.spec.*，该模式属于 Playwright：${block}`,
    );
    assert.ok(block.includes('.test.'), `vitest 的 include 应只覆盖 *.test.*：${block}`);
  }

  assert.match(
    playwrightConfig,
    /testDir:\s*'\.\/tests\/e2e'/,
    'Playwright 应只在 tests/e2e 下查找用例',
  );
  assert.match(
    playwrightConfig,
    /testMatch:\s*'\*\*\/\*\.spec\.ts'/,
    'Playwright 应只匹配 *.spec.ts',
  );
});

test('既有统一命令未被破坏，且已切换到新的测试运行器', () => {
  const scripts = readPackageJson().scripts ?? {};

  // FND-002 的验收脚本会断言这些命令存在，改名会直接让上一阶段的验收失败。
  const preservedCommands = [
    'test',
    'test:unit',
    'test:e2e',
    'check',
    'lint',
    'typecheck',
    'build',
  ];
  for (const command of preservedCommands) {
    assert.equal(typeof scripts[command], 'string', `package.json 缺少统一命令：${command}`);
  }

  assert.match(scripts['test:unit'], /vitest/, 'test:unit 应已切换到 Vitest');
  assert.match(scripts['test:integration'], /vitest/, 'test:integration 应使用 Vitest');
  assert.match(
    scripts['test:e2e'],
    /tests[/\\]e2e/,
    'test:e2e 仍应运行 tests/e2e 下的既有验收脚本（node:test 编写）',
  );
  assert.match(scripts['test:browser'], /playwright/i, 'test:browser 应驱动 Playwright');
  assert.match(scripts['check:all'], /test:browser/, 'check:all 应串联浏览器端测试');
});

test('未引入第二套测试框架', () => {
  const packageJson = readPackageJson();
  const allDependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

  for (const forbidden of ['jest', '@jest/globals', 'mocha', 'ava', 'jasmine']) {
    assert.equal(
      allDependencies[forbidden],
      undefined,
      `不应同时引入 ${forbidden}：两套测试运行器并存会带来无谓的配置割裂与不一致的断言行为`,
    );
  }
});

test('既有单元测试已迁移到 Vitest', () => {
  const migrated = readProjectFile(MIGRATED_UNIT_TEST);

  assert.match(migrated, /from 'vitest'/, 'env.test.ts 应从 vitest 导入测试 API');
  assert.ok(
    !/from 'node:test'/.test(migrated),
    'env.test.ts 不应再依赖 node:test 运行器——迁移未完成时它会被两套运行器重复执行',
  );
});

test('Playwright 的浏览器本体与运行时注册表都收敛到项目内', () => {
  const wrapper = readProjectFile(PLAYWRIGHT_WRAPPER);

  // 两处路径在 Playwright 源码里彼此独立，必须同时覆盖：
  // PLAYWRIGHT_BROWSERS_PATH 管浏览器本体，PWTEST_SERVER_REGISTRY 管运行时注册表。
  // 只覆盖前者会得到「浏览器装对了、运行时仍读写用户目录」的半收敛状态。
  assert.match(
    wrapper,
    /PLAYWRIGHT_BROWSERS_PATH:\s*BROWSERS_DIR/,
    '包装器必须把 PLAYWRIGHT_BROWSERS_PATH 指向项目内目录',
  );
  assert.match(
    wrapper,
    /PWTEST_SERVER_REGISTRY:\s*SERVER_REGISTRY_DIR/,
    '包装器必须把 PWTEST_SERVER_REGISTRY 指向项目内目录，否则运行时会读写用户目录',
  );

  assert.match(wrapper, /PATHS\.cache/, '两处目录都应基于 PATHS.cache 推导');

  assert.ok(
    !/[A-Za-z]:[\\/]Users[\\/]/.test(wrapper) && !/\/(Users|home)\//.test(wrapper),
    '包装器不得硬编码本机绝对路径',
  );
});

test('Playwright 内部注册表变量仍被上游源码引用', () => {
  // 这条断言的作用是「锁死假设」：PWTEST_SERVER_REGISTRY 是 Playwright 的内部变量，
  // 不是公开配置项。一旦上游改名或移除，包装器里的注入会变成无效的空操作——
  // 没有报错、没有警告，只是悄悄退回用户目录。
  // 直接对着已安装的源码断言，让这种失效表现为测试失败，而不是无声的约束破坏。
  const registrySource = readProjectFile(PLAYWRIGHT_SERVER_REGISTRY_SOURCE);

  assert.match(
    registrySource,
    /process\.env\.PWTEST_SERVER_REGISTRY/,
    'Playwright 源码应仍以 PWTEST_SERVER_REGISTRY 作为注册表目录来源；' +
      '若此处失败，说明 Playwright 内部实现已变，需重新确认注册表目录的收敛方式',
  );
});

test('测试产物落在项目内，且不污染项目根', () => {
  const playwrightConfig = readProjectFile(PLAYWRIGHT_CONFIG);

  assert.match(
    playwrightConfig,
    /ARTIFACTS_ROOT\s*=\s*'\.cache\/playwright'/,
    'Playwright 产物根目录应指向 .cache/playwright',
  );
  assert.match(
    playwrightConfig,
    /outputDir:\s*`\$\{ARTIFACTS_ROOT\}/,
    'outputDir 应基于 ARTIFACTS_ROOT 推导',
  );
  assert.match(
    playwrightConfig,
    /outputFolder:\s*`\$\{ARTIFACTS_ROOT\}/,
    'HTML 报告目录应基于 ARTIFACTS_ROOT 推导，否则会在项目根生成 playwright-report/',
  );

  for (const stray of ['test-results', 'playwright-report', 'coverage']) {
    assert.ok(!existsSync(path.join(PROJECT_ROOT, stray)), `项目根不应出现测试产物目录：${stray}`);
  }
});

test('页面 E2E 用例就位（实际浏览器执行见 test:browser）', () => {
  const spec = readProjectFile(E2E_SPEC);

  assert.match(spec, /from '@playwright\/test'/, 'E2E 用例应从 @playwright/test 导入');
  assert.match(spec, /page\.goto\('\/'\)/, 'E2E 用例应真实访问首页');
});

test('app/api 下的每个路由都在接口文档中有登记', () => {
  const apiDoc = readProjectFile(API_DOC);
  const routes = collectApiRoutes(API_ROUTES_DIR);

  assert.ok(routes.length > 0, 'app/api 下应至少存在一个路由');

  /**
   * 把 Next 的动态段目录名换成契约文档的记法。
   *
   * 文档写 `{lifeAreaId}`（HTTP 契约的通行写法），而 Next 的目录名**必须**是
   * `[lifeAreaId]`——这是两种记法，不是两个端点。不归一化的话，任何合法的动态
   * 路由都会被判成"未登记"，而检查器的误报会逼着人把框架语法写进契约文档。
   *
   * 前后断言（lookaround）是有意的：catch-all `[[...slug]]` 在文档里就是**逐字符
   * 这么写的**，不能被归成 `{{...slug}}`。
   */
  function toDocumentedRoute(route) {
    return route.replace(/(?<!\[)\[([^[\]]+)\](?!\])/g, '{$1}');
  }

  for (const route of routes) {
    // 「存在但未登记的 API 表面」比「没有这个接口」更危险：调用方会真的用上它，
    // 而契约文档里查不到，后续改动就没人知道会破坏谁。
    const documented = toDocumentedRoute(route);
    assert.ok(
      apiDoc.includes(`\`${documented}\``),
      `接口文档缺少端点登记：${documented}（Next 目录名 ${route}）。新增 API 必须同步登记路径、是否只读、是否有鉴权、当前范围与后续扩展。`,
    );
  }

  // 反证：同一条判据对一个**真的没登记**的路径必须为假。没有这一步，上面那段
  // 归一化有可能宽到"怎么都能过"——那就等于这条检查不存在。
  assert.ok(
    !apiDoc.includes(`\`${toDocumentedRoute('/life-areas/[notRegistered]')}\``),
    '归一化不应让未登记的路径也匹配上',
  );

  // 归一化本身的自证：动态段被换成花括号，catch-all 原样保留。
  assert.equal(toDocumentedRoute('/life-areas/[lifeAreaId]'), '/life-areas/{lifeAreaId}');
  assert.equal(toDocumentedRoute('/[[...slug]]'), '/[[...slug]]');
});

test('单元测试通过（验收标准：至少一个单元测试）', async () => {
  const result = await runNpm(['run', 'test:unit']);

  assert.equal(result.code, 0, `npm run test:unit 应通过：\n${result.output}`);
});

test('集成测试通过（验收标准：至少一个 API 测试）', async () => {
  const result = await runNpm(['run', 'test:integration']);

  assert.equal(result.code, 0, `npm run test:integration 应通过：\n${result.output}`);
});

test('环境门禁 env:check 仍全绿（无回归）', async () => {
  const result = await runNpm(['run', 'env:check']);

  assert.equal(result.code, 0, `env:check 应通过：\n${result.output}`);
});
