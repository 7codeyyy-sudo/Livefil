#!/usr/bin/env node
/**
 * npm 包装器。
 *
 * 作用：
 * 1. 优先使用项目内便携 Node 自带的 npm，避免依赖系统 Node。
 * 2. 注入项目级环境变量（缓存、遥测），保证依赖与缓存都落在项目目录内。
 * 3. 固定以 PROJECT_ROOT 为工作目录，避免在子目录执行产生额外 node_modules。
 * 4. 把 Node 目录前置进子进程 PATH，使 `npm run <script>` 里的 `node`
 *    解析到锁定版本，而不是 PATH 上碰巧排在前面的任意 Node。
 *
 * 用法：npm run env:npm -- <npm 参数...>
 *      例如：npm run env:npm -- install
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import { PROJECT_ROOT, formatPath, projectEnv } from './paths.mjs';
import { resolveNpmInvocation } from './npm-command.mjs';

const invocation = resolveNpmInvocation();
const npmArgs = process.argv.slice(2);

if (npmArgs.length === 0) {
  console.error('未提供 npm 参数。用法：npm run env:npm -- <npm 参数...>');
  process.exit(2);
}

console.log(`[env:npm] 使用 ${invocation.description}`);
console.log(`[env:npm] 工作目录 ${formatPath(PROJECT_ROOT)}`);
console.log(`[env:npm] 缓存目录 ${formatPath(projectEnv().npm_config_cache)}`);

const baseEnv = projectEnv();

/**
 * 前置进子进程 PATH 的 Node 目录。
 *
 * 为什么必须做：`npm run <script>` 里的脚本用的是 PATH 上的 `node`——npm 只会把
 * `node_modules/.bin` 前置，**不会**带上自己那份 Node。于是本机 PATH 上任意一个
 * Node（可能完全不是 .nvmrc 锁定的版本）会接管所有 npm 脚本与生命周期命令，
 * 「本地能复现 CI 门禁」这件事就不再成立。
 *
 * 便携运行时可用时前置它的目录；否则退回当前进程所在目录，
 * 与 `playwright.mjs` 为同一问题打的补丁保持同款。
 */
const nodeDirectory =
  invocation.kind === 'portable'
    ? path.dirname(invocation.command)
    : path.dirname(process.execPath);

/**
 * 子进程 PATH 的新取值。
 *
 * Windows 的环境变量名大小写不敏感，键名可能是 `PATH` 也可能是 `Path`。
 * 实测两种写法并存时后写入的 `PATH` 生效（子进程读到同一个值），
 * 因此只需覆盖 `PATH`，不必再删掉另一种写法。
 */
const childPath = [nodeDirectory, baseEnv.PATH ?? baseEnv.Path ?? '']
  .filter((segment) => segment !== '')
  .join(path.delimiter);

const child = spawn(invocation.command, [...invocation.prefixArgs, ...npmArgs], {
  cwd: PROJECT_ROOT,
  env: { ...baseEnv, PATH: childPath },
  stdio: 'inherit',
  shell: invocation.useShell,
});

child.on('error', (error) => {
  console.error(`[env:npm] 无法启动 npm：${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[env:npm] npm 被信号 ${signal} 终止。`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
