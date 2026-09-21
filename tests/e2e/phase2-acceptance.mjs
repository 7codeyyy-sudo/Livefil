/**
 * Phase 2 验收脚本（DB-001 / IAM-001 / IAM-002 / IAM-003 / IAM-004）。
 *
 * 把这一批的验收标准固化为可复现的自动检查。**优先做行为验证**（动态 import
 * 真实模块并调用它），只在"被测对象本身就是文本"时才做文本断言——例如 SQL
 * 迁移文件，它的产物就是 SQL。
 *
 * 本脚本**不**启动构建、**不**需要数据库：真机部分在 `tests/db/**`，由
 * `npm run db:test` 驱动（需 `TEST_DATABASE_URL`）。
 *
 * 运行：npm run test:e2e
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { PROJECT_ROOT, formatPath } from '../../scripts/env/paths.mjs';

/** 依赖规则模块（与 FND-004 共用同一份契约，不复制规则）。 */
const DEPENDENCY_RULES_FILE = path.join(
  PROJECT_ROOT,
  'tests',
  'unit',
  'architecture',
  'dependency-rules.ts',
);

const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');
const DRIZZLE_DIR = path.join(PROJECT_ROOT, 'drizzle');
const DRIZZLE_META_DIR = path.join(DRIZZLE_DIR, 'meta');
const COMPOSITION_ROOT = path.join(PROJECT_ROOT, 'composition-root.ts');
const SESSION_COOKIE = path.join(
  PROJECT_ROOT,
  'src',
  'modules',
  'identity',
  'presentation',
  'session-cookie.ts',
);
const COMPONENTS_INDEX = path.join(PROJECT_ROOT, 'src', 'shared', 'ui', 'components', 'index.ts');

/** 读取项目内文件（相对项目根的 POSIX 路径）。 */
function readProjectFile(relativePath) {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

/** 动态 import 项目的 `.ts` 源文件（Node 22 默认剥离类型）。 */
async function importSource(absolutePath) {
  return import(pathToFileURL(absolutePath).href);
}

/** 列出目录下的文件名（目录不存在时返回空数组）。 */
function listDirectory(absoluteDir) {
  if (!existsSync(absoluteDir)) {
    return [];
  }
  return readdirSync(absoluteDir, { withFileTypes: true });
}

/** 递归收集指定扩展名的源码文件（相对项目根的 POSIX 路径 + 内容）。 */
function collectFiles(absoluteDir, extensions) {
  const collected = [];

  for (const entry of listDirectory(absoluteDir)) {
    const absoluteEntry = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectFiles(absoluteEntry, extensions));
      continue;
    }
    if (!extensions.some((extension) => entry.name.endsWith(extension))) {
      continue;
    }
    collected.push({
      relativePath: path.relative(PROJECT_ROOT, absoluteEntry).split(path.sep).join('/'),
      content: readFileSync(absoluteEntry, 'utf8'),
    });
  }

  return collected;
}

test('数据库迁移已入库且只向前', () => {
  const schemaFile = path.join(DRIZZLE_DIR, 'schema.ts');
  assert.ok(existsSync(schemaFile), `缺少 drizzle schema：${formatPath(schemaFile)}`);

  const sqlFiles = listDirectory(DRIZZLE_DIR)
    .filter((entry) => entry.isFile() && /^\d{4}_.*\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  // 迁移文件**必须提交**：它不进仓库，CI 与任何新环境都建不出库，
  // 而"本地能跑"会一直掩盖这件事直到有人换机器。
  assert.ok(sqlFiles.length > 0, 'drizzle/ 下没有任何版本化 SQL 迁移');

  const journalPath = path.join(DRIZZLE_META_DIR, '_journal.json');
  assert.ok(existsSync(journalPath), `缺少迁移日志：${formatPath(journalPath)}`);

  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const entries = journal.entries ?? [];
  assert.equal(
    entries.length,
    sqlFiles.length,
    '迁移日志的条目数应与 SQL 文件数一致（不一致说明有迁移没被登记）',
  );

  for (const [index, entry] of entries.entries()) {
    assert.equal(
      entry.idx,
      index,
      `迁移日志的 idx 应当连续递增，第 ${String(index)} 项为 ${String(entry.idx)}`,
    );
  }
});

test('首个迁移建出两张表与关键约束', () => {
  const sqlFiles = listDirectory(DRIZZLE_DIR)
    .filter((entry) => entry.isFile() && /^\d{4}_.*\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const sql = readFileSync(path.join(DRIZZLE_DIR, sqlFiles[0]), 'utf8');

  // 迁移文件的"行为"就是它生成出来的 SQL，因此这里断言文本是恰当的。
  assert.match(sql, /CREATE TABLE "users"/, '迁移应建出 users 表');
  assert.match(sql, /CREATE TABLE "life_areas"/, '迁移应建出 life_areas 表');
  assert.match(sql, /"version" bigint DEFAULT 1 NOT NULL/, 'users.version 是乐观并发的基础');
  assert.match(
    sql,
    /"timezone" varchar\(64\)/,
    'users.timezone 按《数据库设计文档》§4.1 应为 varchar(64)',
  );
  assert.match(
    sql,
    /"quiet_hours_start" time/,
    'quiet_hours 起止应为 time 列（只存时刻，不存日期）',
  );

  // 单本地用户的部分唯一索引：`SELECT ... FOR UPDATE` 对空结果集不加锁，
  // 并发首启只能靠这个索引串行化。
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "users_single_local_unique"[^;]*WHERE mode = 'local'/,
    '缺少"至多一个本地用户"的部分唯一索引',
  );

  // 归档项不占名字（靠索引而不是预检，避免 TOCTOU 窗口）。
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "life_areas_user_active_name_unique"[^;]*WHERE is_archived = false/,
    '缺少"未归档领域同名唯一"的部分唯一索引',
  );
});

test('组合根位于项目根，且 app 层不引用任何基础设施', async () => {
  assert.ok(
    existsSync(COMPOSITION_ROOT),
    `组合根应在项目根（与 instrumentation.ts 同级）：${formatPath(COMPOSITION_ROOT)}`,
  );

  const compositionRootSource = readFileSync(COMPOSITION_ROOT, 'utf8');
  // `server-only` 是硬要求：它保证组合根永远不会被打进客户端包。
  assert.match(compositionRootSource, /import 'server-only';/, '组合根必须声明 server-only');

  const { findViolations, formatViolations, DEPENDENCY_RULES } =
    await importSource(DEPENDENCY_RULES_FILE);

  // 前提校验：规则表必须真的覆盖 app 目录，否则下面那条断言是空转。
  assert.ok(
    DEPENDENCY_RULES.some((rule) => rule.appliesTo === 'app'),
    '依赖规则表应包含针对 app 的规则',
  );

  const appFiles = collectFiles(path.join(PROJECT_ROOT, 'app'), ['.ts', '.tsx']);
  assert.ok(appFiles.length > 0, '应收集到 app 下的源码');
  assert.deepEqual(
    findViolations(appFiles),
    [],
    `app 层不应引用基础设施：\n${formatViolations(findViolations(appFiles))}`,
  );

  // 反向探针：造一个 app 下的越界引用，检查器必须能检出——否则它只是个摆设。
  const { findViolations: findProbe } = await importSource(DEPENDENCY_RULES_FILE);
  const probe = [
    {
      relativePath: 'app/__probe__/page.ts',
      content:
        "import { createDatabaseClient } from '../../src/infrastructure/database/client.ts';",
    },
  ];
  assert.equal(findProbe(probe).length, 1, 'app 引用基础设施的探针应被检出');
});

test('本地会话的端点与 Cookie 契约', async () => {
  const routeFiles = {
    session: path.join('app', 'api', 'v1', 'auth', 'local', 'session', 'route.ts'),
    me: path.join('app', 'api', 'v1', 'me', 'route.ts'),
    lifeAreas: path.join('app', 'api', 'v1', 'life-areas', 'route.ts'),
    lifeAreaItem: path.join('app', 'api', 'v1', 'life-areas', '[lifeAreaId]', 'route.ts'),
    reorder: path.join('app', 'api', 'v1', 'life-areas', 'reorder', 'route.ts'),
  };

  for (const relativePath of Object.values(routeFiles)) {
    assert.ok(existsSync(path.join(PROJECT_ROOT, relativePath)), `缺少端点文件：${relativePath}`);
  }

  // 方法必须与《接口文档》一致：导出名决定 Next 接受哪个 HTTP 方法。
  //
  // ⚠️ 这里只能做**文本断言**，不能动态 import：路由模块引用了 `next/server`
  // 与 `@/` 别名，两者都只在 Next 的构建期解析（纯 Node 下 `next/server` 需要
  // `.js` 后缀、`@/` 根本不是包）。接口的**行为**由 `tests/integration/api/**`
  // 直接调用路由处理函数验证——那才是真正执行它的地方。
  const expectedMethods = {
    session: ['POST'],
    me: ['GET', 'PATCH'],
    lifeAreas: ['GET', 'POST'],
    lifeAreaItem: ['PATCH', 'DELETE'],
    reorder: ['POST'],
  };

  for (const [name, methods] of Object.entries(expectedMethods)) {
    const source = readProjectFile(routeFiles[name]);
    for (const method of methods) {
      assert.ok(
        new RegExp(`export const ${method}\\b`).test(source),
        `${routeFiles[name]} 应导出 ${method}`,
      );
    }
  }

  // 云端端点整批挂账（决策 T-006）：本批不该出现任何云端实现。
  assert.ok(
    !existsSync(path.join(PROJECT_ROOT, 'app', 'api', 'v1', 'auth', 'cloud')),
    '云端认证端点属挂账范围，本批不应实现',
  );

  // Cookie 属性的"行为"就是函数返回值，直接调用它。
  const { SESSION_COOKIE_NAME, sessionCookieAttributes } = await importSource(SESSION_COOKIE);
  assert.equal(SESSION_COOKIE_NAME, 'livefil_session');

  const development = sessionCookieAttributes(false);
  assert.equal(development.httpOnly, true, 'httpOnly 必须为 true（XSS 防护）');
  assert.equal(development.sameSite, 'lax');
  assert.equal(development.path, '/');
  assert.equal(
    development.secure,
    false,
    '本地 http 下 secure 必须为 false——否则浏览器会丢弃 Cookie，会话永远建不起来',
  );
  assert.equal(sessionCookieAttributes(true).secure, true, '生产必须为 secure');
  assert.ok(!('maxAge' in development) && !('expires' in development), '不应设置过期时间');
});

test('环境变量的分层必填（§8.3）', async () => {
  // 根校验保持 optional：build、health、styleguide、CI 都不依赖数据库与密钥，
  // 强制必填会让这些路径整体失败。
  const { parseServerEnv } = await importSource(
    path.join(PROJECT_ROOT, 'src', 'shared', 'validation', 'env.ts'),
  );
  const parsed = parseServerEnv({});
  assert.equal(parsed.databaseUrl, undefined);
  assert.equal(parsed.authSecret, undefined);
  // 新增的测试库变量同样是 optional（它只在 db:test 时需要）。
  assert.equal(parsed.testDatabaseUrl, undefined);

  // 必填约束下沉到真正需要它的地方。这两个工厂都引用了 `@/` 别名，纯 Node
  // 无法 import（见上面路由那条的同理说明），所以这里断言**结构**，
  // 它们的**行为**由 `tests/unit/infrastructure/session-signer.test.ts` 与
  // `tests/db/**` 的真机用例覆盖。
  const clientSource = readProjectFile('src/infrastructure/database/client.ts');
  assert.match(
    clientSource,
    /DependencyUnavailableError/,
    '连接工厂缺 DATABASE_URL 时应抛 DEPENDENCY_UNAVAILABLE',
  );
  assert.match(clientSource, /DATABASE_URL/, '错误信息应指出是哪个变量缺失');

  const signerSource = readProjectFile('src/infrastructure/auth/session-signer.ts');
  assert.match(signerSource, /InvariantError/, '会话签名器缺 AUTH_SECRET 时应抛装配期错误');
  assert.match(signerSource, /AUTH_SECRET/, '错误信息应指出是哪个变量缺失');

  // 两个错误都不回显取值（NFR-SEC-002）：源码里不应出现把取值拼进消息的写法。
  for (const [name, source] of [
    ['client.ts', clientSource],
    ['session-signer.ts', signerSource],
  ]) {
    assert.ok(
      !/message:\s*[^,\n]*\$\{[^}]*connectionString/.test(source) &&
        !/message:\s*[^,\n]*\$\{[^}]*secret/.test(source),
      `${name} 的报错不得回显连接串或密钥取值`,
    );
  }
});

test('依赖分组与 db 脚本', () => {
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));

  // 运行时依赖：服务启动就要用。
  for (const name of ['drizzle-orm', 'pg']) {
    assert.ok(packageJson.dependencies?.[name], `${name} 应在 dependencies`);
  }
  // 开发依赖：只有迁移与类型需要。
  for (const name of ['drizzle-kit', '@types/pg']) {
    assert.ok(packageJson.devDependencies?.[name], `${name} 应在 devDependencies`);
    assert.ok(!packageJson.dependencies?.[name], `${name} 不应出现在 dependencies`);
  }

  // 版本风格与全仓一致：精确版本，不用 ^ 或 ~。
  for (const name of ['drizzle-orm', 'pg', 'drizzle-kit', '@types/pg']) {
    const version = packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name];
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} 的版本应为精确版本，实际为 ${version}`);
  }

  for (const script of ['db:generate', 'db:migrate', 'db:test', 'db:dev:up', 'db:dev:down']) {
    assert.ok(packageJson.scripts?.[script], `缺少脚本 ${script}`);
    // 依赖安装与 CLI 调用必须走项目内的 env 包装器（便携 Node + 项目内缓存）。
    assert.match(
      packageJson.scripts[script],
      /scripts\/env\//,
      `${script} 应经 scripts/env 包装器调用`,
    );
  }
});

test('新增源码与测试不含硬编码的机器绝对路径', () => {
  const files = [
    ...collectFiles(path.join(PROJECT_ROOT, 'src'), ['.ts', '.tsx']),
    ...collectFiles(path.join(PROJECT_ROOT, 'app'), ['.ts', '.tsx', '.css']),
    ...collectFiles(path.join(PROJECT_ROOT, 'drizzle'), ['.ts']),
    ...collectFiles(path.join(PROJECT_ROOT, 'scripts'), ['.mjs']),
    ...collectFiles(path.join(PROJECT_ROOT, 'tests', 'db'), ['.mjs']),
    { relativePath: 'instrumentation.ts', content: readProjectFile('instrumentation.ts') },
    { relativePath: 'drizzle.config.ts', content: readProjectFile('drizzle.config.ts') },
  ];

  // 只匹配字面盘符路径。测试里的正则模式（如断言用到的 `[A-Za-z]:[\\/]`）本身
  // 不是路径，因此这里用字符类排除掉误报。
  const absolutePathPattern = /(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]{1,2}(?!\\)/;
  const offenders = files
    .filter((file) => absolutePathPattern.test(file.content))
    .map((file) => file.relativePath);

  assert.deepEqual(offenders, [], `以下文件含硬编码绝对路径：\n${offenders.join('\n')}`);
});

test('设置页与开关组件已落地', () => {
  const settingsDir = path.join(PROJECT_ROOT, 'app', '(app)', 'settings');
  const required = [
    path.join(settingsDir, 'page.tsx'),
    path.join(settingsDir, 'SettingsPanel.tsx'),
    path.join(settingsDir, '_components', 'SettingsForm.tsx'),
    path.join(settingsDir, '_components', 'PreferenceSections.tsx'),
    path.join(settingsDir, '_components', 'LifeAreasSection.tsx'),
    path.join(settingsDir, '_components', 'SettingsSection.tsx'),
    path.join(settingsDir, '_components', 'settings-draft.ts'),
    path.join(settingsDir, '_components', 'settings-hooks.ts'),
  ];

  for (const absolute of required) {
    assert.ok(existsSync(absolute), `缺少设置页文件：${path.basename(absolute)}`);
  }

  // 设置页不再是占位页（占位页只该留给尚未交付的页面）。
  const pageSource = readFileSync(path.join(settingsDir, 'page.tsx'), 'utf8');
  assert.ok(
    !pageSource.includes('PlaceholderPage'),
    '设置页应交付真实内容，而不是 PlaceholderPage',
  );

  // 开关必须在公共出口里：§5 要求 AI 开关用 role=switch，而"组件库没有它"
  // 曾是一个真实缺口。
  const componentsIndex = readFileSync(COMPONENTS_INDEX, 'utf8');
  assert.match(componentsIndex, /export \{ Switch \}/, 'Switch 应从组件出口导出');
  assert.match(componentsIndex, /export \{ AsyncState \}/, 'AsyncState 应从组件出口导出');
});

test('服务端源码不向客户端包泄露密钥读取逻辑', () => {
  // `import 'server-only'` 是唯一可靠的手段：一旦某个客户端组件误引用，
  // 构建会立刻失败，而不是把读取密钥的代码悄悄打进浏览器。
  assert.match(readFileSync(COMPOSITION_ROOT, 'utf8'), /import 'server-only';/);

  // 客户端组件不得直接引用基础设施或组合根。
  const clientFiles = collectFiles(path.join(PROJECT_ROOT, 'app'), ['.tsx'])
    .filter((file) => file.content.startsWith("'use client';"))
    .concat(
      collectFiles(path.join(PROJECT_ROOT, 'src', 'shared', 'ui'), ['.tsx', '.ts']).filter((file) =>
        file.content.startsWith("'use client';"),
      ),
    );

  assert.ok(clientFiles.length > 0, '应收集到客户端组件');

  const offenders = clientFiles.filter(
    (file) =>
      file.content.includes("'server-only'") ||
      /from '[^']*(?:src\/infrastructure|\/infrastructure\/)/.test(file.content) ||
      /from '[^']*composition-root/.test(file.content),
  );

  assert.deepEqual(
    offenders.map((file) => file.relativePath),
    [],
    '客户端组件不得引用服务端基础设施或组合根',
  );
});
