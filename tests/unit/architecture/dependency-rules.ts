/**
 * 分层依赖规则（FND-004）。
 *
 * 把《概要设计说明书》§4 的分层职责与《详细设计说明书》§2 的目录结构，
 * 固化成机器可判定的规则。规则本身就是架构契约——改动它等同于改动架构，
 * 应当与改文档同等慎重。
 *
 * 依赖方向的依据：
 * - 概设 §4.1 表现层「调用版本化 API，不直接访问数据库」。
 * - 概设 §4.3 应用服务层「编排用例、转换 DTO」，是页面与领域之间的唯一通道。
 * - 概设 §4.4 领域层「不依赖 Next.js、HTTP、PostgreSQL 或具体 AI 厂商」。
 * - 概设 §4.5 基础设施层「所有外部依赖通过接口接入」→ 只能实现领域端口，不得反向依赖。
 * - 概设 §10 架构验收「领域模块可在不启动 Next.js 的情况下运行单元测试」。
 */
import { extractImportSpecifiers, normalizeSpecifier, type SourceFile } from './imports.ts';

/**
 * 一条依赖边界规则。
 *
 * 路径模式采用**目录语义**：`src/modules/<模块>/domain` 同时匹配该目录本身
 * 与其中的任意文件，因此不需要额外补通配后缀。
 *
 * 注意：下方模式里的星号只应出现在字符串字面量中——写进块注释时，
 * 星号紧邻斜杠会提前闭合注释，使后续内容被当作代码。
 */
export interface DependencyRule {
  /** 规则名，用于失败信息与验收脚本断言。 */
  readonly name: string;
  /** 适用该规则的源文件目录（相对项目根的 POSIX 路径模式）。 */
  readonly appliesTo: string;
  /** 禁止引用的外部包名（不含子路径，如 `next` 可拦下 `next/server`）。 */
  readonly forbiddenPackages: readonly string[];
  /** 禁止引用的项目内目录。 */
  readonly forbiddenPaths: readonly string[];
  /** 违反时的说明，解释「为什么不能这样引用」。 */
  readonly reason: string;
}

/** 领域层禁止依赖的框架包。 */
const FRAMEWORK_PACKAGES: readonly string[] = ['next', 'react', 'react-dom'];

/**
 * 分层依赖契约。
 *
 * 顺序不影响判定结果：一个文件可以同时命中多条规则，全部违规都会被报告。
 */
export const DEPENDENCY_RULES: readonly DependencyRule[] = [
  {
    name: '领域层不得依赖框架、应用层与基础设施',
    appliesTo: 'src/modules/*/domain',
    forbiddenPackages: FRAMEWORK_PACKAGES,
    forbiddenPaths: [
      'src/modules/*/application',
      'src/modules/*/infrastructure',
      'src/infrastructure',
      'app',
    ],
    reason:
      '领域层必须能脱离 Next.js 单独运行单元测试（《概要设计》§10），' +
      '且不感知持久化与接口实现（§4.4）。',
  },
  {
    name: '应用层不得依赖框架与基础设施实现',
    appliesTo: 'src/modules/*/application',
    forbiddenPackages: FRAMEWORK_PACKAGES,
    forbiddenPaths: ['src/modules/*/infrastructure', 'src/infrastructure', 'app'],
    reason:
      '应用层负责用例编排与事务边界，不应绑定展示框架；' +
      '对基础设施只能经领域定义的端口访问（《概要设计》§4.3、§4.5）。',
  },
  {
    name: '表现层不得越过应用层访问领域与基础设施',
    appliesTo: 'src/modules/*/presentation',
    forbiddenPackages: [],
    forbiddenPaths: ['src/modules/*/domain', 'src/modules/*/infrastructure', 'src/infrastructure'],
    reason: '页面与组件只消费应用层暴露的用例与 DTO（《详细设计》§4.3）。',
  },
  {
    name: 'App Router 不得直接访问领域内部与基础设施',
    appliesTo: 'app',
    forbiddenPackages: [],
    forbiddenPaths: ['src/modules/*/domain', 'src/modules/*/infrastructure', 'src/infrastructure'],
    reason:
      '页面与路由属表现层与 API 适配层，不得直接访问数据库实现（FND-004 任务描述、' +
      '《概要设计》§4.1）。',
  },
  {
    name: '模块内基础设施不得反向依赖应用层与表现层',
    appliesTo: 'src/modules/*/infrastructure',
    forbiddenPackages: FRAMEWORK_PACKAGES,
    forbiddenPaths: ['src/modules/*/application', 'src/modules/*/presentation', 'app'],
    reason:
      '模块内的基础设施（仓储与外部适配器的实现）只实现本模块领域定义的端口' +
      '（《概要设计》§4.5）。它可以引用领域层、共享层与顶层基础设施' +
      '（复用数据库客户端等），但不得反向依赖用例服务或页面。' +
      '这里禁用框架包，是因为仓储实现不应感知 Web 框架。',
  },
  {
    name: '顶层基础设施不得反向依赖应用层与表现层',
    appliesTo: 'src/infrastructure',
    forbiddenPaths: ['src/modules/*/application', 'src/modules/*/presentation', 'app'],
    // 刻意不禁用框架包：顶层基础设施含认证实现，需要 Next.js 的 cookies/headers。
    // 与模块内基础设施的差异是有理由的，不是遗漏。
    forbiddenPackages: [],
    reason:
      '顶层基础设施是跨模块共享的技术实现，同样只对领域端口负责；' +
      '反向依赖会形成循环，并让替换实现变得不可能（《概要设计》§4.5）。',
  },
  {
    name: '共享层不得依赖业务模块与基础设施',
    appliesTo: 'src/shared',
    forbiddenPaths: ['src/modules', 'src/infrastructure', 'app'],
    forbiddenPackages: [],
    reason: '共享层被所有层引用，一旦反向依赖业务模块或基础设施就会形成依赖环。',
  },
];

export interface Violation {
  /** 违规文件（相对项目根）。 */
  readonly file: string;
  /** 原始导入说明符。 */
  readonly specifier: string;
  /** 归一化后的目标（项目内路径或包名）。 */
  readonly resolved: string;
  /** 命中的规则名。 */
  readonly rule: string;
  /** 违规原因。 */
  readonly reason: string;
}

/**
 * 转义正则元字符。
 *
 * @param value 原始文本。
 * @returns 可直接嵌入正则的文本。
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把目录模式编译为正则。
 *
 * @param pattern 以 `/` 分隔的目录模式，支持 `*`（单段）与 `**`（任意多段）。
 * @returns 匹配「该目录本身及其内部任意路径」的正则。
 */
function compileDirectoryPattern(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((segment) => {
      if (segment === '**') {
        return '.*';
      }
      if (segment === '*') {
        return '[^/]+';
      }
      return escapeRegExp(segment);
    })
    .join('/');

  // 尾部的可选分组让模式同时匹配目录自身（`a/b`）与其中的文件（`a/b/c.ts`）。
  return new RegExp(`^${body}(?:/.*)?$`);
}

/**
 * 判断路径是否落在某个目录模式内。
 *
 * @param relativePath 待判定的 POSIX 相对路径。
 * @param pattern 目录模式。
 * @returns 命中时为 true。
 */
export function matchesDirectoryPattern(relativePath: string, pattern: string): boolean {
  return compileDirectoryPattern(pattern).test(relativePath);
}

/**
 * 取出说明符对应的包名。
 *
 * @param specifier 原始说明符。
 * @returns scoped 包返回 `@scope/name`，普通包返回首段，相对路径原样返回。
 */
export function toPackageName(specifier: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return specifier;
  }

  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments.slice(0, 2).join('/');
  }
  return segments[0] ?? specifier;
}

/**
 * 在给定文件集合中找出全部依赖违规。
 *
 * @param files 待检查的源文件。
 * @param rules 依赖规则，默认使用 {@link DEPENDENCY_RULES}。
 * @returns 违规列表；无违规则为空数组。
 */
export function findViolations(
  files: readonly SourceFile[],
  rules: readonly DependencyRule[] = DEPENDENCY_RULES,
): readonly Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    for (const specifier of extractImportSpecifiers(file.content)) {
      const resolved = normalizeSpecifier(specifier, file.relativePath);
      const packageName = toPackageName(specifier);

      for (const rule of rules) {
        if (!matchesDirectoryPattern(file.relativePath, rule.appliesTo)) {
          continue;
        }

        const hitsPackage = rule.forbiddenPackages.includes(packageName);
        const hitsPath = rule.forbiddenPaths.some((pattern) =>
          matchesDirectoryPattern(resolved, pattern),
        );

        if (!hitsPackage && !hitsPath) {
          continue;
        }

        violations.push({
          file: file.relativePath,
          specifier,
          resolved,
          rule: rule.name,
          reason: rule.reason,
        });
      }
    }
  }

  return violations;
}

/**
 * 把违规列表渲染成可读的多行文本。
 *
 * @param violations 违规列表。
 * @returns 每条违规一行；为空时返回提示语。
 */
export function formatViolations(violations: readonly Violation[]): string {
  if (violations.length === 0) {
    return '未发现依赖边界违规。';
  }

  return violations
    .map(
      (violation) =>
        `${violation.file}: 引用了「${violation.specifier}」（解析为 ${violation.resolved}）\n` +
        `  ↳ 违反规则：${violation.rule}\n` +
        `  ↳ 原因：${violation.reason}`,
    )
    .join('\n');
}
