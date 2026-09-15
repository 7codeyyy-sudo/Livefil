/**
 * 项目路径解析模块。
 *
 * 设计目标：
 * 1. 所有目录一律从 PROJECT_ROOT 动态推导，代码中不出现任何本机绝对路径。
 * 2. PROJECT_ROOT 通过「标记文件」向上查找确定，因此脚本从任意子目录启动都能定位到项目根。
 * 3. 路径拼接统一使用 node:path，保证 Windows/POSIX 均可运行。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 项目根目录标记文件。
 * 该文件是项目根的唯一判据，由《Livefil 文档目录》保证存在。
 */
const ROOT_MARKER = path.join('doc', 'README.md');

/**
 * 沿目录树向上查找项目根目录。
 *
 * @param {string} startDir 起始目录；只用于查找，不会被写入任何文件。
 * @returns {string} 项目根目录的绝对路径（运行期使用）。
 * @throws {Error} 向上直到文件系统根仍未找到标记文件时抛出。
 */
export function resolveProjectRoot(startDir) {
  let current = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(current, ROOT_MARKER))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `无法定位项目根目录：从 ${startDir} 向上未找到标记文件 ${ROOT_MARKER}。` +
          '请确认当前脚本位于 Livefil 项目目录内。',
      );
    }
    current = parent;
  }
}

/** 项目根目录绝对路径（仅运行期使用，不写入任何源码、配置或文档）。 */
export const PROJECT_ROOT = resolveProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

function inRoot(...segments) {
  return path.join(PROJECT_ROOT, ...segments);
}

/**
 * 项目内目录布局，与《开发环境规范》§2.1 保持一致。
 * @type {Readonly<Record<string, string>>}
 */
export const PATHS = Object.freeze({
  projectRoot: PROJECT_ROOT,
  nodeModules: inRoot('node_modules'),
  scripts: inRoot('scripts'),
  docker: inRoot('docker'),
  runtime: inRoot('.runtime'),
  portableNode: inRoot('.runtime', 'node'),
  postgresData: inRoot('.runtime', 'postgres'),
  logs: inRoot('.runtime', 'logs'),
  uploads: inRoot('.runtime', 'uploads'),
  exports: inRoot('.runtime', 'exports'),
  backups: inRoot('.runtime', 'backups'),
  aiCache: inRoot('.runtime', 'ai-cache'),
  cache: inRoot('.cache'),
  npmCache: inRoot('.cache', 'npm'),
  nextCache: inRoot('.cache', 'next'),
  data: inRoot('.data'),
  envLocal: inRoot('.env.local'),
  envExample: inRoot('.env.example'),
  gitIgnore: inRoot('.gitignore'),
  packageJson: inRoot('package.json'),
  nodeVersionFile: inRoot('.nvmrc'),
});

/**
 * 由 bootstrap 负责创建的项目内目录（顺序即创建顺序）。
 * 这些目录承载依赖、缓存、日志、导出和备份，避免落到系统用户目录。
 * @type {readonly string[]}
 */
export const MANAGED_DIRECTORIES = Object.freeze([
  PATHS.runtime,
  PATHS.portableNode,
  PATHS.postgresData,
  PATHS.logs,
  PATHS.uploads,
  PATHS.exports,
  PATHS.backups,
  PATHS.aiCache,
  PATHS.cache,
  PATHS.npmCache,
  PATHS.nextCache,
  PATHS.data,
]);

/**
 * 生成项目级环境变量，供子进程（npm、next 等）继承。
 *
 * 目的：把包管理器缓存与遥测数据固定在项目目录内，避免写入用户目录。
 *
 * @param {NodeJS.ProcessEnv} [baseEnv] 基础环境变量，默认取当前进程环境。
 * @returns {NodeJS.ProcessEnv} 合并后的环境变量副本。
 */
export function projectEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    LIVEFIL_PROJECT_ROOT: PROJECT_ROOT,
    npm_config_cache: PATHS.npmCache,
    NEXT_TELEMETRY_DISABLED: baseEnv.NEXT_TELEMETRY_DISABLED ?? '1',
  };
}

/**
 * 判断 child 是否位于 parent 目录之内。
 * 用于校验各类产物没有逃出项目目录。
 *
 * @param {string} parent 父目录。
 * @param {string} child 待校验目录或文件。
 * @returns {boolean} child 在 parent 内（含同一路径）时为 true。
 */
export function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 把绝对路径格式化为以 PROJECT_ROOT 为基准的相对表示，便于在报告中展示，
 * 避免把本机目录结构固化到输出内容里。
 *
 * @param {string} target 目标路径。
 * @returns {string} 项目内相对表示；目标在项目外时原样返回。
 */
export function formatPath(target) {
  if (!isInside(PROJECT_ROOT, target)) {
    return target;
  }
  const relative = path.relative(PROJECT_ROOT, target);
  return relative === '' ? 'PROJECT_ROOT' : path.join('PROJECT_ROOT', relative);
}
