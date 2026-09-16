#!/usr/bin/env node
/**
 * Playwright CLI 包装器（FND-003）。
 *
 * 存在的唯一理由：把 Playwright 的**全部落盘位置**固定在项目目录内。
 *
 * 它需要覆盖两处彼此独立的路径：
 *   1. `PLAYWRIGHT_BROWSERS_PATH` —— 浏览器本体（约 150MB 的大头）。
 *   2. `PWTEST_SERVER_REGISTRY`  —— 浏览器运行时注册表（文件很小，但每次启动
 *      浏览器都会读写，默认同样落在用户目录）。这一处**不响应**前者，
 *      只设第 1 项会导致「浏览器装对了、运行时仍去 C 盘」这种半收敛状态。
 *
 * 为什么必须由包装器承担，而不能写进 `playwright.config.ts`：
 *   `playwright install` **根本不加载**配置文件（它不启动浏览器），
 *   配置里的设置对安装阶段无效，因此只能注入进程环境。
 *
 * 与 `npm.mjs` 同构：注入项目级环境变量后转调真实 CLI，退出码原样透传。
 *
 * 用法：
 *   node scripts/env/playwright.mjs install chromium
 *   node scripts/env/playwright.mjs test
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { PATHS, PROJECT_ROOT, formatPath, projectEnv } from './paths.mjs';

/** 项目内浏览器安装目录。与 `playwright.config.ts` 中的产物目录同属 .cache/playwright 下。 */
const BROWSERS_DIR = path.join(PATHS.cache, 'playwright', 'browsers');

/**
 * 项目内浏览器注册表目录。
 *
 * Playwright 运行时会维护一份浏览器实例注册表（playwright-core 的 `serverRegistry`），
 * 默认落在 `%LOCALAPPDATA%\ms-playwright\b`——见其 `registryDirectory()`：
 * `path.join(defaultCacheDirectory(), 'ms-playwright', 'b')`。
 *
 * 该目录**不响应** `PLAYWRIGHT_BROWSERS_PATH`：两者在源码里是彼此独立的路径来源。
 * 因此只覆盖浏览器本体并不足以收敛落盘位置，必须用 `PWTEST_SERVER_REGISTRY`
 * 单独覆盖（见同文件 `_browsersDir()`：`process.env.PWTEST_SERVER_REGISTRY || registryDirectory()`）。
 *
 * 注意：该变量名带 `PWTEST_` 前缀，属 Playwright 内部变量而非公开配置项，
 * 未来版本可能改名或移除。验收脚本已加断言，一旦源码里不再引用它就会失败，
 * 从而强制复验，而不是静默退回用户目录。
 */
const SERVER_REGISTRY_DIR = path.join(PATHS.cache, 'playwright', 'server-registry');

/** Playwright CLI 入口。 */
const PLAYWRIGHT_CLI = path.join(PROJECT_ROOT, 'node_modules', 'playwright', 'cli.js');

const cliArgs = process.argv.slice(2);

if (cliArgs.length === 0) {
  console.error('未提供 Playwright 参数。用法：node scripts/env/playwright.mjs <install|test|...>');
  process.exit(2);
}

if (!existsSync(PLAYWRIGHT_CLI)) {
  console.error(
    `未找到 Playwright CLI：${formatPath(PLAYWRIGHT_CLI)}\n` +
      '请先安装依赖：npm run env:npm -- install',
  );
  process.exit(1);
}

console.log(`[playwright] 工作目录 ${formatPath(PROJECT_ROOT)}`);
console.log(`[playwright] 浏览器目录 ${formatPath(BROWSERS_DIR)}`);

const baseEnv = projectEnv();

/** 便携 Node 所在目录，内含 node 可执行文件与 npm。 */
const PORTABLE_NODE_DIR = path.dirname(process.execPath);

/**
 * 调用方现有的 PATH。
 *
 * Windows 的环境变量名大小写不敏感，但键名可能以任一形式出现，因此两种都取。
 */
const inheritedPath = baseEnv.PATH ?? baseEnv.Path ?? '';

const child = spawn(process.execPath, [PLAYWRIGHT_CLI, ...cliArgs], {
  cwd: PROJECT_ROOT,
  env: {
    ...baseEnv,
    // 覆盖 Playwright 默认的用户级安装目录。
    PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIR,
    // 覆盖浏览器运行时注册表目录。PLAYWRIGHT_BROWSERS_PATH 管不到它，
    // 少了这一项，每次启动浏览器仍会在 %LOCALAPPDATA%\ms-playwright\b 下读写。
    PWTEST_SERVER_REGISTRY: SERVER_REGISTRY_DIR,
    // 把便携 Node 前置进 PATH：`playwright.config.ts` 的 `webServer.command`
    // 需要执行 `npm run build`，不这样做就会依赖调用方 PATH 里恰好有可用的
    // Node 与 npm——在只装了项目便携运行时的机器上会直接失败。
    PATH: [PORTABLE_NODE_DIR, inheritedPath]
      .filter((segment) => segment !== '')
      .join(path.delimiter),
  },
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`[playwright] 无法启动 Playwright：${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[playwright] Playwright 被信号 ${signal} 终止。`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
