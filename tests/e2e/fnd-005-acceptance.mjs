/**
 * FND-005 验收脚本。
 *
 * 把任务验收标准固化为可复现的自动检查：
 *   1. 错误码表与《接口文档》§1.4 **完全一致**——从文档正文解析，而不是比对代码里的副本。
 *   2. 每个错误码都有错误类承载，且 HTTP 状态由码唯一决定。
 *   3. `toErrorResponse` 产出结构与文档逐字段一致；非 AppError 不泄露原始信息。
 *   4. 脱敏是**行为**：喂入含敏感值的上下文，断言输出中不含原文。
 *   5. requestId 贯穿：合法头被采纳、非法头被拒绝并生成新值。
 *   6. `src/**` 禁止 `console`，且例外只允许出现在 logger 的 sink 实现里、必须带理由。
 *
 * 运行：npm run test:e2e
 *
 * 关于验证方式：本脚本大量使用**动态 import 加载 `.ts` 源文件**并调用真实函数，
 * 而不是对文件内容做正则匹配。原因是「配置里写了」与「行为正确」是两回事——
 * FND-004 的覆盖度检查就曾因为用文本关键词判断而漏掉一整层目录。
 * Node 22 默认剥离类型，因此可以直接加载项目的 `.ts` 源码。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { PATHS, PROJECT_ROOT, formatPath, projectEnv } from '../../scripts/env/paths.mjs';

/** 单条外部命令的最长等待时间。 */
const COMMAND_TIMEOUT_MS = 300_000;

const API_DOC = path.join(PROJECT_ROOT, 'doc', '05-technical-design', '接口文档.md');
const ERROR_CODE_FILE = path.join(PROJECT_ROOT, 'src', 'shared', 'errors', 'error-code.ts');
const APP_ERROR_FILE = path.join(PROJECT_ROOT, 'src', 'shared', 'errors', 'app-error.ts');
const API_RESPONSE_FILE = path.join(
  PROJECT_ROOT,
  'src',
  'shared',
  'errors',
  'api-error-response.ts',
);
const LOGGER_FILE = path.join(PROJECT_ROOT, 'src', 'shared', 'telemetry', 'logger.ts');
const REQUEST_ID_FILE = path.join(PROJECT_ROOT, 'src', 'shared', 'telemetry', 'request-id.ts');
const ESLINT_CONFIG = path.join(PROJECT_ROOT, 'eslint.config.mjs');

/** 接入层文件：原语只有被这些文件真正调用，才算在运行系统里生效。 */
const PROXY_FILE = path.join(PROJECT_ROOT, 'proxy.ts');

/** 已被 Next 16 废弃的文件约定。与 proxy.ts 并存会让构建直接失败（E900）。 */
const DEPRECATED_MIDDLEWARE_FILE = path.join(PROJECT_ROOT, 'middleware.ts');

const HEALTH_ROUTE_FILE = path.join(PROJECT_ROOT, 'app', 'api', 'v1', 'health', 'route.ts');
const FALLBACK_ROUTE_FILE = path.join(PROJECT_ROOT, 'app', 'api', 'v1', '[[...slug]]', 'route.ts');

/**
 * 模块加载 URL 缓存。
 *
 * 同一路径重复 `import()` 命中模块缓存，不会重复执行，因此无需自行缓存；
 * 这里只做「路径 → file URL」的一次性转换。
 */
function moduleUrl(absolutePath) {
  assert.ok(existsSync(absolutePath), `缺少源文件：${formatPath(absolutePath)}`);
  return pathToFileURL(absolutePath).href;
}

const nodeExecutable = (() => {
  const portable = path.join(
    PATHS.portableNode,
    process.platform === 'win32' ? 'node.exe' : 'bin/node',
  );
  return existsSync(portable) ? portable : process.execPath;
})();

/** 便携 Node 自带的 npm CLI。 */
const npmCli = path.join(PATHS.portableNode, 'node_modules', 'npm', 'bin', 'npm-cli.js');

/** 项目内的 ESLint CLI。 */
const eslintBin = path.join(PROJECT_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');

/**
 * 执行一条 Node 命令并收集输出。
 *
 * @param {readonly string[]} args 传给 Node 的参数（首项为脚本路径）。
 * @param {{ input?: string, timeoutMs?: number }} [options] 可选输入与超时。
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, output: string }>}
 */
function runNode(args, options = {}) {
  const { input, timeoutMs = COMMAND_TIMEOUT_MS } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, args, {
      cwd: PROJECT_ROOT,
      env: projectEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
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
      reject(new Error(`命令超时（${timeoutMs}ms）：${args.join(' ')}\n${stdout}${stderr}`));
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

/** 以项目便携 npm 执行指定参数。 */
function npmArgs(...args) {
  return [npmCli, ...args];
}

/**
 * 读取项目内文件。
 *
 * @param {string} absolutePath 目标文件绝对路径。
 * @returns {string} 文件内容。
 */
function readProjectFile(absolutePath) {
  assert.ok(existsSync(absolutePath), `缺少文件：${formatPath(absolutePath)}`);
  return readFileSync(absolutePath, 'utf8');
}

/**
 * 以项目 ESLint 检查一段内存中的代码。
 *
 * @param {string} source 源码。
 * @param {string} virtualPath 虚拟路径，决定套用哪一段配置。
 * @returns {Promise<readonly string[]>} 报出的规则 ID 列表。
 */
async function lintSnippet(source, virtualPath) {
  const result = await runNode(
    [eslintBin, '--stdin', '--stdin-filename', virtualPath, '--format', 'json'],
    { input: source },
  );

  if (result.stdout.trim() === '') {
    // 配置或插件出错时 ESLint 不产出 JSON。必须报出原始输出，
    // 否则会被误读成「代码合规」——这正是最危险的假阳性。
    throw new Error(`ESLint 未产出结果（退出码 ${result.code}）：\n${result.output}`);
  }

  const reports = JSON.parse(result.stdout);
  return reports.flatMap((report) => (report.messages ?? []).map((message) => message.ruleId));
}

/**
 * 从《接口文档》§1.4 的错误码表中解析出错误码。
 *
 * @param {string} apiDoc 接口文档全文。
 * @returns {readonly string[]} 错误码列表（已排序）。
 */
function parseErrorCodesFromDoc(apiDoc) {
  const section = apiDoc.slice(apiDoc.indexOf('### 1.4 错误响应'));
  const codes = [...section.matchAll(/^\|\s*\d+\s*\|\s*`([A-Z_]+)`\s*\|/gm)].map(
    (match) => match[1],
  );
  return codes.sort();
}

test('错误码表与《接口文档》§1.4 完全一致', async () => {
  const documentedCodes = parseErrorCodesFromDoc(readProjectFile(API_DOC));
  assert.ok(documentedCodes.length > 0, '未能从接口文档解析出错误码，请检查文档格式是否变化');

  const { ERROR_CODES } = await import(moduleUrl(ERROR_CODE_FILE));

  assert.deepEqual(
    [...ERROR_CODES].sort(),
    documentedCodes,
    '代码中的错误码必须与《接口文档》§1.4 逐项一致：这是已确认的对外契约',
  );
});

test('每个错误码都有错误类承载，且 HTTP 状态与文档一致', async () => {
  const { ERROR_CODES, HTTP_STATUS_BY_ERROR_CODE } = await import(moduleUrl(ERROR_CODE_FILE));
  const errors = await import(moduleUrl(APP_ERROR_FILE));

  const contractInstances = [
    new errors.ValidationError('x'),
    new errors.AuthenticationError('x'),
    new errors.AuthorizationError('x'),
    new errors.NotFoundError('x'),
    new errors.ConflictError('x'),
    new errors.IdempotencyReplayError('x'),
    new errors.RateLimitError('x'),
    new errors.DependencyUnavailableError('x'),
    new errors.DependencyTimeoutError('x'),
    new errors.InternalError(),
  ];

  const coveredCodes = contractInstances.map((instance) => instance.code).sort();

  assert.deepEqual(
    coveredCodes,
    [...ERROR_CODES].sort(),
    '每个错误码都应有对应的错误类，否则该码永远不会被使用',
  );

  // 内部错误对外必须归一化，不能引入文档之外的新码。
  for (const instance of [new errors.DatabaseError(), new errors.InvariantError()]) {
    assert.equal(instance.code, 'INTERNAL_ERROR', '内部错误对外必须呈现为 INTERNAL_ERROR');
  }

  // HTTP 状态由码唯一决定，逐项对照接口文档。
  const documentedStatusByCode = {
    VALIDATION_ERROR: 400,
    AUTHENTICATION_REQUIRED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    IDEMPOTENCY_REPLAY: 409,
    RATE_LIMITED: 429,
    DEPENDENCY_UNAVAILABLE: 502,
    DEPENDENCY_TIMEOUT: 504,
    INTERNAL_ERROR: 500,
  };
  // 展开为普通对象后整体比对：逐项断言无法发现「多了一个码」。
  assert.deepEqual({ ...HTTP_STATUS_BY_ERROR_CODE }, documentedStatusByCode);
});

test('错误响应结构逐字段对齐《接口文档》§1.4', async () => {
  const errors = await import(moduleUrl(APP_ERROR_FILE));
  const { toErrorResponse } = await import(moduleUrl(API_RESPONSE_FILE));

  const requestId = '550e8400-e29b-41d4-a716-446655440000';
  const result = toErrorResponse(
    new errors.ValidationError('任务标题不能为空', { fields: { title: 'required' } }),
    requestId,
  );

  assert.equal(result.status, 400);
  assert.deepEqual(result.body, {
    error: {
      code: 'VALIDATION_ERROR',
      message: '任务标题不能为空',
      fields: { title: 'required' },
      requestId,
    },
  });
});

test('非 AppError 的原始信息不会进入错误响应', async () => {
  const { toErrorResponse } = await import(moduleUrl(API_RESPONSE_FILE));

  const result = toErrorResponse(
    new Error('connect ECONNREFUSED 10.0.0.5:5432 (postgres) select * from users'),
    '550e8400-e29b-41d4-a716-446655440000',
  );

  const serialized = JSON.stringify(result.body);

  assert.equal(result.body.error.code, 'INTERNAL_ERROR');
  for (const leaked of ['ECONNREFUSED', '5432', 'postgres', 'select * from users']) {
    assert.ok(!serialized.includes(leaked), `错误响应不得包含内部信息：${leaked}`);
  }
});

test('日志脱敏是行为：敏感原文不出现在输出中', async () => {
  const { createLogger } = await import(moduleUrl(LOGGER_FILE));

  const records = [];
  const logger = createLogger({
    sink: { write: (record) => records.push(record) },
    now: () => new Date('2026-09-16T04:00:00.000Z'),
    appVersion: '0.1.0',
  });

  logger.info('创建任务', {
    requestId: 'req-1',
    password: 'hunter2',
    accessToken: 'eyJhbGciOiJIUzI1NiJ9',
    authorization: 'Bearer secret-token',
    taskTitle: 'x'.repeat(500),
  });

  const serialized = JSON.stringify(records);

  for (const secret of ['hunter2', 'eyJhbGciOiJIUzI1NiJ9', 'secret-token', 'x'.repeat(500)]) {
    assert.ok(!serialized.includes(secret), '日志不得包含敏感原文');
  }

  // 非敏感字段必须保留，否则日志失去排查价值。
  assert.equal(records[0]?.requestId, 'req-1');
});

test('requestId 贯穿：合法头被采纳、非法头被拒绝', async () => {
  const { isValidRequestId, resolveRequestId } = await import(moduleUrl(REQUEST_ID_FILE));

  const provided = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(resolveRequestId(provided), provided);

  for (const hostile of [null, '', 'req_123', `${provided}\nX-Injected: 1`, 'a'.repeat(500)]) {
    const resolved = resolveRequestId(hostile);
    assert.ok(isValidRequestId(resolved), '非法输入必须被替换为生成的合法 UUID');
    assert.ok(!resolved.includes('X-Injected'), '不得把注入内容带入响应头或日志');
  }
});

test('src 下禁止 console，scripts 与 tests 不受影响', async () => {
  const eslintConfig = readProjectFile(ESLINT_CONFIG);
  assert.match(eslintConfig, /no-console/, 'eslint 配置应包含 no-console 规则');

  const srcRuleIds = await lintSnippet(
    "console.log('leak');\nexport const probe = 1;\n",
    'src/shared/errors/__probe__.ts',
  );
  assert.ok(
    srcRuleIds.includes('no-console'),
    `src 下的 console 应被拦下，实际报出：${srcRuleIds.join(', ')}`,
  );

  const scriptRuleIds = await lintSnippet("console.log('ok');\n", 'scripts/__probe__.mjs');
  assert.ok(
    !scriptRuleIds.includes('no-console'),
    'scripts 下的 console 不应被拦——它们是给人看的开发工具输出',
  );

  const testRuleIds = await lintSnippet(
    "console.log('ok');\nexport const probe = 1;\n",
    'tests/unit/__probe__.ts',
  );
  assert.ok(!testRuleIds.includes('no-console'), 'tests 下的 console 不应被拦');
});

test('console 例外只允许出现在 logger 的 sink 实现内且必须带理由', () => {
  const loggerSource = readProjectFile(LOGGER_FILE);
  const disables = loggerSource.match(/eslint-disable-next-line no-console/g) ?? [];

  assert.equal(
    disables.length,
    1,
    'console 例外应当只有一处（sink 实现），多出来说明有人在绕过日志通道',
  );
  assert.match(
    loggerSource,
    /eslint-disable-next-line no-console -- \S/,
    '行内例外必须写明理由，否则后人无法判断它是否还成立',
  );
});

test('requestId 代理层与错误包装器已接入真实路由', () => {
  const proxySource = readProjectFile(PROXY_FILE);
  const healthSource = readProjectFile(HEALTH_ROUTE_FILE);
  const fallbackSource = readProjectFile(FALLBACK_ROUTE_FILE);

  // Next 16 起 `middleware` 文件约定已废弃并更名为 `proxy`。两者共存会让构建
  // 直接失败（E900），所以这条断言防的不是「还留着旧文件」这种整洁问题，
  // 而是一个会让生产构建挂掉的硬错误。
  assert.ok(
    !existsSync(DEPRECATED_MIDDLEWARE_FILE),
    'middleware.ts 与 proxy.ts 不能并存，否则构建报 E900 直接失败',
  );
  assert.match(
    proxySource,
    /export function proxy\(/,
    '导出函数必须命名为 proxy（或用 default 导出），否则构建失败',
  );

  // 存在性检查。FND-005 的原语若零生产调用，「接口失败返回统一结构」就只是
  // 测试里的说法，而不是系统的行为——这正是上一轮审查指出的问题。
  //
  // 这里刻意用文本断言而不是动态 import：这两个文件使用了 `@/` 路径别名，
  // Node 无法直接解析。为了验收脚本能 import 而改掉项目别名是本末倒置。
  // 真正的行为验证由下面的集成测试运行与 tests/e2e/api-contract.spec.ts 承担。
  assert.match(proxySource, /matcher:\s*\['\/api\/:path\*'\]/, '代理层应只作用于 API 路径');
  assert.match(proxySource, /resolveRequestId\(/, '代理层应调用 resolveRequestId');

  // proxy 恒定运行在 Node.js 运行时，声明 `runtime` 会让生产构建抛错（E1031），
  // dev 下却只告警——即它不会在日常开发中暴露。删掉是对的，且要防止被加回来。
  assert.doesNotMatch(
    proxySource,
    /\bruntime\s*:/,
    'proxy 文件不得声明 runtime：proxy 恒定 Node.js 运行时，声明会被 Next 拒绝',
  );

  assert.match(healthSource, /createApiRouteHandler\(/, 'health 路由应经统一包装器导出');
  assert.match(fallbackSource, /createApiRouteHandler\(/, '404 兜底路由应经统一包装器导出');
  assert.match(fallbackSource, /NotFoundError/, '404 兜底应抛 NotFoundError');
});

test('接入层的集成测试通过（行为验证在 Vitest 侧完成）', async () => {
  // 真实调用代理层与包装器、断言真实的 Response 状态码/头/JSON 体，
  // 这些用例在 tests/integration/api/ 下，由具备路径别名解析能力的 Vitest 执行。
  const result = await runNode(npmArgs('run', 'test:integration'));

  assert.equal(result.code, 0, `npm run test:integration 应通过：\n${result.output}`);
});

test('环境门禁 env:check 仍全绿（无回归）', async () => {
  const result = await runNode(npmArgs('run', 'env:check'));

  assert.equal(result.code, 0, `env:check 应通过：\n${result.output}`);
});
