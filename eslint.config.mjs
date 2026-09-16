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
  // 测试产物兜底。项目内配置已把 Playwright 输出指向 .cache/playwright/，
  // 这里防止绕过项目脚本（直接 npx playwright test）时在项目根留下的目录被 lint 扫描。
  'test-results/**',
  'playwright-report/**',
  // 项目内运行数据与缓存（开发环境规范 §2.1）
  '.runtime/**',
  '.cache/**',
  '.data/**',
  // 由工具生成，不参与人工维护
  'next-env.d.ts',
  // Git 钩子：`.husky/pre-commit` 是无扩展名的 shell 脚本，`.husky/_/` 是 husky
  // 生成的引导层（含各 hook 的 shim）。两者都不是本项目用手写的 JS/TS，
  // 显式忽略以免 lint 遍历时产生「无法匹配配置」的噪音。
  '.husky/**',
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
 * 分层依赖边界（FND-004）。
 *
 * 这里只覆盖**最关键的一条**：领域层不得依赖框架与基础设施实现。
 *
 * 完整的依赖矩阵（表现层、应用层、基础设施、共享层的相互方向）由
 * `tests/unit/architecture/dependency-boundaries.test.ts` 校验。分工的理由：
 * ESLint 的 `no-restricted-imports` 表达不了「A 可引用 B、但 B 不可引用 A」
 * 这类跨目录方向规则，那需要 `eslint-plugin-import` 的 zones；而为一条规则
 * 新增一个直接依赖并不划算。
 *
 * 保留这一条的价值是**即时反馈**：写代码的当下就标红，而不是等到跑测试。
 *
 * 注意 `patterns` 使用 minimatch 语义，`*` 不跨 `/`，因此需要同时列出
 * 「包本身」与「包内子路径」两种写法。
 */
const LAYER_BOUNDARY_RULES = {
  files: ['src/modules/*/domain/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['next', 'next/*', 'react', 'react/*', 'react-dom', 'react-dom/*'],
            message:
              '领域层不得依赖 Next.js 或 React：它必须能脱离框架单独运行单元测试' +
              '（《概要设计》§10）。规则与原因见 tests/unit/architecture/dependency-rules.ts。',
          },
          {
            group: [
              '@/infrastructure',
              '@/infrastructure/**',
              '**/infrastructure',
              '**/infrastructure/**',
            ],
            message:
              '领域层不得依赖基础设施实现：持久化、认证与 AI 都应以领域定义的端口注入' +
              '（《概要设计》§4.4、§4.5）。规则与原因见 tests/unit/architecture/dependency-rules.ts。',
          },
          {
            group: [
              '@/modules/*/application',
              '@/modules/*/application/**',
              '**/application',
              '**/application/**',
            ],
            message:
              '领域层不得依赖应用层：依赖方向应为 application → domain，反向会形成环。' +
              '规则与原因见 tests/unit/architecture/dependency-rules.ts。',
          },
        ],
      },
    ],
  },
};

/**
 * 日志通道约束（FND-005）。
 *
 * `src/**` 下禁止直接使用 `console`。
 *
 * 理由不是「console 不好」，而是它会让日志规范**整体失效**：绕过 logger 之后，
 * 脱敏、requestId 贯穿、字段规范化全部不生效，而这些恰恰是日志规范存在的目的。
 * 一处 `console.log` 就足以把 token 直接打进采集管道。
 *
 * 唯一的例外是 logger 自己的 sink 实现（`src/shared/telemetry/logger.ts`），
 * 它以行内 `eslint-disable-next-line` 声明，理由写在那一行旁边——
 * 这里的例外必须局部可见，而不是在配置里开一个大口子。
 *
 * `scripts/**` 与 `tests/**` 不受约束：它们是开发工具与测试，输出给人看，
 * 不进入生产日志管道。本规则只作用于 `src/**`，因此无需额外声明例外。
 */
const LOGGING_CHANNEL_RULES = {
  files: ['src/**/*.{ts,tsx}'],
  rules: {
    // 不带选项即「一律禁止」。刻意不写成 `{ allow: [] }`——ESLint 要求 allow 数组
    // 至少有一项，空数组会让整份配置加载失败，从而**所有规则一起失效**，
    // 而报错信息只提到这个选项，容易让人误以为只是这一条规则有问题。
    'no-console': 'error',
  },
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
  LAYER_BOUNDARY_RULES,
  LOGGING_CHANNEL_RULES,
  prettierCompat,
];

export default config;
