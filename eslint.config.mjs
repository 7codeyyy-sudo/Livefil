/**
 * ESLint Flat Config（FND-002）。
 *
 * 为什么是 Flat Config 而不是 `.eslintrc.*`：ESLint 9 起 flat config 是唯一受支持的
 * 格式，`.eslintrc.*` 已进入弃用流程。为什么必须直接调用 `eslint` CLI：Next.js 16
 * 已移除 `next lint` 子命令，脚手架不再代为转调。
 *
 * 配置按「顺序即优先级」分层，后者覆盖前者：
 *   1. 全局忽略 —— 只忽略构建产物、运行数据与生成文件，不忽略任何业务源码。
 *   2. eslint-config-next/core-web-vitals —— Next 推荐规则集（含 React、React Hooks、
 *      import、jsx-a11y 以及 Core Web Vitals 相关规则）。
 *   3. eslint-config-next/typescript —— TypeScript 规则集（基于 typescript-eslint 推荐集）。
 *   4. 项目自有约束 —— 见 PROJECT_RULES 及其中说明。
 *   5. eslint-config-prettier/flat —— **必须放在最后**。它逐个关闭与 Prettier 冲突的
 *      排版类规则，避免「ESLint 要求换行、Prettier 要求不换行」的反复拉锯。
 *      它只关闭排版规则，不会关闭代码质量规则。
 */
import prettierCompat from 'eslint-config-prettier/flat';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * 全局忽略清单。
 *
 * 原则：忽略「不是人手写、且不由本项目维护」的文件；不忽略任何业务源码目录。
 * 依赖目录（node_modules、.git）由 ESLint 默认忽略，无需在此重复声明。
 */
const GLOBAL_IGNORES = [
  // 框架与打包产物
  '.next/**',
  'out/**',
  'build/**',
  'dist/**',
  'coverage/**',
  // 项目内运行数据与缓存（开发环境规范 §2.1）
  '.runtime/**',
  '.cache/**',
  '.data/**',
  // 由工具生成，不参与人工维护
  'next-env.d.ts',
  // 已冻结的静态原型：属历史产物，不属本期任务范围，保持逐字节原样
  'prototype/**',
];

/**
 * 项目自有规则。
 *
 * 这里只补充「上游配置未覆盖、且本项目确有需要」的规则，不重复声明上游已开启的项，
 * 避免同一意图出现两个定义源后互相漂移。
 */
const PROJECT_RULES = {
  // 这一条是本配置存在的主要理由：`tsconfig.json` 刻意关闭了 noUnusedLocals /
  // noUnusedParameters（原因见该文件内注释——它们与 ESLint 职责重叠，且会对 Next.js
  // 路由签名产生无价值噪音）。未使用变量与参数的检查由此处接手。
  // 两处不能同时落空，否则未使用变量将完全没有检查。
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      // 只检查「最后一个已使用参数之后」的参数，避免为了签名而不得不使用的前置参数报错。
      args: 'after-used',
      // 以 `_` 开头的参数/变量视为「有意不使用」，是社区通行约定。
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      // 捕获到的错误同样不允许默默丢弃：要么使用，要么显式用 `_` 命名表示已知忽略
      // （对应 universal-code-quality 的「不允许空 catch 或静默吞错」）。
      caughtErrors: 'all',
      caughtErrorsIgnorePattern: '^_',
      // `const { unused, ...rest } = obj` 的解构忽略不计入未使用。
      ignoreRestSiblings: true,
    },
  ],

  // 禁止空语句块，但允许显式注释说明的空块。
  'no-empty': ['error', { allowEmptyCatch: false }],
};

/**
 * Flat config 导出的完整配置。
 *
 * 刻意赋给具名常量后再导出（而不是直接 `export default [...]`）：
 * 匿名默认导出会让调试与堆栈信息失去可读的标识，且 `import/no-anonymous-default-export`
 * 会直接报出该问题。具名中间变量同时让上面的分层结构在阅读时更清晰。
 */
const config = [
  { ignores: GLOBAL_IGNORES },
  ...nextCoreWebVitals,
  ...nextTypescript,
  { rules: PROJECT_RULES },
  prettierCompat,
];

export default config;
