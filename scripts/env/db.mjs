#!/usr/bin/env node
/**
 * 数据库 CLI 包装器（DB-001）。
 *
 * 与 `npm.mjs` / `playwright.mjs` 同构：注入项目级环境后转调真实 CLI，退出码原样透传。
 * 它多做的一件事是**在使用前强制检查连接串**（《详细设计》§8.3「分层必填」）：
 *
 * - 根环境校验（`src/shared/validation/env.ts`）对 `DATABASE_URL` 保持 optional，
 *   因为 health / styleguide / CI 等入口不依赖数据库；强制必填会让这些路径整体失败。
 * - 必填约束下沉到**真正需要它的地方**。对迁移与真机测试而言，那就是这里：
 *   缺变量时给一句能直接照做的错误，而不是让驱动抛一个含义不清的 URL 解析异常。
 *
 * 用法：
 *   node scripts/env/db.mjs generate   # 由 schema 生成版本化 SQL 迁移（不连库）
 *   node scripts/env/db.mjs migrate    # 应用迁移（需 DATABASE_URL）
 *   node scripts/env/db.mjs test       # 跑真机数据库测试（需 TEST_DATABASE_URL）
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT, formatPath, projectEnv } from './paths.mjs';

/** drizzle-kit 的 CLI 入口。 */
const DRIZZLE_KIT_CLI = path.join(PROJECT_ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs');

/** 真机数据库测试的目录与文件名模式。 */
const DB_TEST_DIR = path.join('tests', 'db');

const command = process.argv[2];
const extraArgs = process.argv.slice(3);

/**
 * 检查某个环境变量是否存在，缺失则打印明确错误并退出。
 *
 * **只报变量名，不回显取值**（NFR-SEC-002）：连接串里带密码，任何一处日志
 * 都不该把它打出来。
 */
function requireEnv(variableName, purpose) {
  const value = process.env[variableName];
  if (typeof value !== 'string' || value.trim() === '') {
    console.error(
      `[db] 缺少环境变量 ${variableName}（${purpose}）。\n` +
        `     请在项目根目录的 .env.local 中配置后重试。变量取值不会被打印。`,
    );
    process.exit(2);
  }
}

/**
 * 组装子进程环境：把便携 Node 目录前置进 PATH。
 *
 * drizzle-kit 由 `process.execPath` 直接启动，本身不查 PATH；但迁移过程可能
 * 触发子进程（例如将来的自定义 SQL 脚本），与其它包装器保持一致可以免掉
 * "在只装了项目便携运行时的机器上失败"这类问题。
 */
function childEnv(overrides = {}) {
  const baseEnv = projectEnv();
  const inheritedPath = baseEnv.PATH ?? baseEnv.Path ?? '';
  const portableNodeDir = path.dirname(process.execPath);

  return {
    ...baseEnv,
    ...overrides,
    PATH: [portableNodeDir, inheritedPath].filter((segment) => segment !== '').join(path.delimiter),
  };
}

/** 启动一个子进程并把退出码透传出去。 */
function run(executable, args, env, label) {
  const child = spawn(executable, args, {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    console.error(`[db] 无法启动${label}：${error.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`[db] ${label}被信号 ${signal} 终止。`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

console.log(`[db] 工作目录 ${formatPath(PROJECT_ROOT)}`);

switch (command) {
  case 'generate': {
    // 生成迁移不连库：它只读 `drizzle/schema.ts` 并与已有迁移比对。
    if (!existsSync(DRIZZLE_KIT_CLI)) {
      console.error(`[db] 未找到 drizzle-kit：${formatPath(DRIZZLE_KIT_CLI)}\n     请先安装依赖。`);
      process.exit(1);
    }
    run(process.execPath, [DRIZZLE_KIT_CLI, 'generate', ...extraArgs], childEnv(), 'drizzle-kit');
    break;
  }

  case 'migrate': {
    requireEnv('DATABASE_URL', '应用数据库迁移');
    if (!existsSync(DRIZZLE_KIT_CLI)) {
      console.error(`[db] 未找到 drizzle-kit：${formatPath(DRIZZLE_KIT_CLI)}\n     请先安装依赖。`);
      process.exit(1);
    }
    run(process.execPath, [DRIZZLE_KIT_CLI, 'migrate', ...extraArgs], childEnv(), 'drizzle-kit');
    break;
  }

  case 'test': {
    requireEnv('TEST_DATABASE_URL', '真机数据库测试');
    // 指向**测试库**而不是开发库：这一层会做空库迁移与事务回滚，
    // 用错库等于把开发数据洗一遍。
    run(
      process.execPath,
      ['--test', '--test-concurrency=1', `${DB_TEST_DIR}/**/*.mjs`, ...extraArgs],
      childEnv({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
      '数据库测试',
    );
    break;
  }

  default: {
    console.error(
      '用法：node scripts/env/db.mjs <generate|migrate|test>\n' +
        '  generate  由 schema 生成版本化 SQL 迁移（不连库）\n' +
        '  migrate   应用迁移（需 DATABASE_URL）\n' +
        '  test      跑真机数据库测试（需 TEST_DATABASE_URL）',
    );
    process.exit(2);
  }
}
