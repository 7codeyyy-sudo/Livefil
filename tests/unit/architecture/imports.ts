/**
 * 源码 import 语句的静态解析（FND-004）。
 *
 * 用于把「分层依赖方向」从文档约定变成可执行检查：解析每个源文件引用了什么，
 * 再交给 {@link file://./dependency-rules.ts} 判定是否越界。
 *
 * 为什么用静态解析而不是 ESLint 插件：完整的依赖矩阵需要表达跨目录方向
 * （「A 可以引用 B，但 B 不能引用 A」），这需要 `eslint-plugin-import` 的
 * `no-restricted-paths`；而它并非本项目的直接依赖，引入它只为一条规则不划算。
 * 用几十行解析代码换零新增依赖，同时把规则集中的矩阵完整表达出来。
 *
 * 已知边界：解析基于正则而非 AST，因此**必须先剥离注释**——否则注释里作为
 * 反例出现的 `import ... from 'next/server'` 会被当成真实依赖，产生假阳性。
 * 剥离逻辑见 {@link stripComments}；字符串字面量中的注释符号仍可能被误伤，
 * 但本项目源码可控，且误伤方向是「漏检」而非「误报」，代价可接受。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 参与架构检查的源码扩展名。 */
const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx'];

/** 路径别名前缀，与 `tsconfig.json` 的 `paths` 保持一致。 */
const ALIAS_PREFIX = '@/';

/** 别名对应的真实目录（相对项目根）。 */
const ALIAS_TARGET = 'src/';

/** 匹配 `import ... from '...'` 与 `export ... from '...'`。 */
const FROM_SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;

/** 匹配无绑定的副作用导入 `import '...'`。 */
const BARE_SPECIFIER = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

/** 匹配动态导入 `import('...')`。 */
const DYNAMIC_SPECIFIER = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 匹配 CommonJS 的 `require('...')`。 */
const REQUIRE_SPECIFIER = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 全部导入形态，按此顺序收集。 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  FROM_SPECIFIER,
  BARE_SPECIFIER,
  DYNAMIC_SPECIFIER,
  REQUIRE_SPECIFIER,
];

export interface SourceFile {
  /** 相对项目根的 POSIX 风格路径，例如 `src/modules/tasks/domain/task.ts`。 */
  readonly relativePath: string;
  /** 文件内容。 */
  readonly content: string;
}

/**
 * 把平台路径分隔符统一为 `/`。
 *
 * @param value 任意路径字符串。
 * @returns POSIX 风格路径。
 */
export function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * 去掉源码中的注释。
 *
 * @param source 源码内容。
 * @returns 移除注释后的内容。
 */
export function stripComments(source: string): string {
  return (
    source
      // 块注释优先处理，避免其中的 `//` 干扰后续的行注释匹配。
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // 行注释：要求 `//` 前一个字符不是 `:`，以免把 `https://` 截断成注释。
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  );
}

/**
 * 提取源码引用的全部模块说明符。
 *
 * @param content 源码内容。
 * @returns 去重并排序后的说明符列表。
 */
export function extractImportSpecifiers(content: string): readonly string[] {
  const source = stripComments(content);
  const specifiers = new Set<string>();

  for (const pattern of SPECIFIER_PATTERNS) {
    // 带 `g` 标志的正则会被 matchAll 复制并沿用 lastIndex，
    // 跨文件复用同一实例前必须重置，否则会漏掉前面的匹配。
    const matches = source.matchAll(new RegExp(pattern.source, pattern.flags));

    for (const match of matches) {
      const specifier = match[1];
      if (specifier !== undefined && specifier.trim() !== '') {
        specifiers.add(specifier);
      }
    }
  }

  return [...specifiers].sort();
}

/**
 * 把导入说明符归一化为「项目内相对路径」或「外部包名」。
 *
 * @param specifier 原始说明符。
 * @param importerRelativePath 发起导入的文件路径（相对项目根）。
 * @returns `@/x` 与相对路径被解析为项目内 POSIX 路径；外部包原样返回。
 */
export function normalizeSpecifier(specifier: string, importerRelativePath: string): string {
  if (specifier.startsWith(ALIAS_PREFIX)) {
    return `${ALIAS_TARGET}${specifier.slice(ALIAS_PREFIX.length)}`;
  }

  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const importerDir = path.posix.dirname(importerRelativePath);
    return path.posix.normalize(path.posix.join(importerDir, specifier));
  }

  // 外部包、`node:` 内置模块、scoped 包一律保持原样，由包名规则判定。
  return specifier;
}

/**
 * 递归收集目录下的所有 TypeScript 源文件。
 *
 * @param absoluteDir 起始目录（绝对路径，仅运行期使用）。
 * @param projectRoot 项目根绝对路径，用于计算相对路径。
 * @returns 源文件列表；目录不存在时返回空列表。
 */
export function collectSourceFiles(
  absoluteDir: string,
  projectRoot: string,
): readonly SourceFile[] {
  const files: SourceFile[] = [];

  // 目录尚未创建时返回空列表而不是抛错：骨架刚建立、业务代码尚未落地的阶段，
  // 这条检查同样要能正常跑通。
  if (!existsSync(absoluteDir)) {
    return files;
  }

  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const absoluteEntry = path.join(absoluteDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(absoluteEntry, projectRoot));
      continue;
    }

    if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      continue;
    }

    files.push({
      relativePath: toPosixPath(path.relative(projectRoot, absoluteEntry)),
      content: readFileSync(absoluteEntry, 'utf8'),
    });
  }

  return files;
}
