/**
 * npm 调用定位模块。
 *
 * 通过 `node <npm-cli.js>` 的方式调用 npm，可以绕开 Windows 下 .cmd 包装脚本的
 * shell 转义问题，并保证优先使用项目内便携 Node 自带的 npm。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';

/**
 * 便携 Node 中 npm-cli.js 的候选相对路径。
 * Windows 发行包位于 node_modules/npm，POSIX 发行包位于 lib/node_modules/npm。
 */
const NPM_CLI_RELATIVE_PATHS = Object.freeze([
  path.join('node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
]);

/**
 * 解析应当使用的 npm 调用方式。
 *
 * @returns {{
 *   kind: 'portable' | 'fallback',
 *   command: string,
 *   prefixArgs: string[],
 *   useShell: boolean,
 *   description: string,
 * }} 调用描述；portable 表示使用项目内便携 Node，fallback 表示回退到系统 npm。
 */
export function resolveNpmInvocation() {
  const portableNodeExecutable = path.join(
    PATHS.portableNode,
    process.platform === 'win32' ? 'node.exe' : 'bin/node',
  );

  for (const relativePath of NPM_CLI_RELATIVE_PATHS) {
    const npmCliPath = path.join(PATHS.portableNode, relativePath);
    if (existsSync(npmCliPath) && existsSync(portableNodeExecutable)) {
      return {
        kind: 'portable',
        command: portableNodeExecutable,
        prefixArgs: [npmCliPath],
        useShell: false,
        description: '项目内便携 Node 自带的 npm',
      };
    }
  }

  return {
    kind: 'fallback',
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    prefixArgs: [],
    useShell: process.platform === 'win32',
    description: '当前 PATH 上的系统 npm（未检测到项目内便携 Node）',
  };
}
