#!/usr/bin/env node
/**
 * npm 包装器。
 *
 * 作用：
 * 1. 优先使用项目内便携 Node 自带的 npm，避免依赖系统 Node。
 * 2. 注入项目级环境变量（缓存、遥测），保证依赖与缓存都落在项目目录内。
 * 3. 固定以 PROJECT_ROOT 为工作目录，避免在子目录执行产生额外 node_modules。
 *
 * 用法：npm run env:npm -- <npm 参数...>
 *      例如：npm run env:npm -- install
 */
import { spawn } from 'node:child_process';
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

const child = spawn(invocation.command, [...invocation.prefixArgs, ...npmArgs], {
  cwd: PROJECT_ROOT,
  env: projectEnv(),
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
