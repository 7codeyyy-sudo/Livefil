#!/usr/bin/env node
/**
 * ENV-003 项目本地目录初始化。
 *
 * 幂等操作：重复执行只补齐缺失目录，不会删除或覆盖任何已有内容。
 * 用法：npm run env:bootstrap
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { MANAGED_DIRECTORIES, PROJECT_ROOT, formatPath } from './paths.mjs';

/**
 * 确保目录存在。
 *
 * @param {string} directory 目标目录绝对路径。
 * @returns {'created' | 'existed'} 本次操作结果。
 */
function ensureDirectory(directory) {
  if (existsSync(directory)) {
    if (!statSync(directory).isDirectory()) {
      throw new Error(`${formatPath(directory)} 已存在但不是目录，请先人工确认后处理。`);
    }
    return 'existed';
  }
  mkdirSync(directory, { recursive: true });
  return 'created';
}

const created = [];
const existed = [];

for (const directory of MANAGED_DIRECTORIES) {
  if (ensureDirectory(directory) === 'created') {
    created.push(formatPath(directory));
  } else {
    existed.push(formatPath(directory));
  }
}

console.log(`项目根目录：${PROJECT_ROOT}`);
for (const directory of created) {
  console.log(`  已创建  ${directory}`);
}
for (const directory of existed) {
  console.log(`  已存在  ${directory}`);
}
console.log(`目录初始化完成：新建 ${created.length} 个，已存在 ${existed.length} 个。`);
