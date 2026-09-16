/**
 * Vitest 配置（FND-003）。
 *
 * 为什么是 `.mts` 而不是 `.ts`：项目 `package.json` 未设置 `"type": "module"`，
 * 因此 `.ts` 配置文件会被 Vite 当作 **CommonJS** 加载，而本文件使用了
 * `import.meta.url`（ESM 专有）。Vite 8 会对此发出兼容性警告，并预告在未来的
 * 主版本 `configLoader: 'native'` 成为默认后直接失效。用 `.mts` 明确声明 ESM，
 * 既消除警告，也避免将来升级时踩坑。
 *
 * 为什么不给 `package.json` 加 `"type": "module"`：那会改变整个项目所有
 * `.js/.ts` 文件的模块解析语义，影响面远超本任务范围，且与 Next.js 的
 * 模块约定存在冲突风险。改一个文件扩展名是影响面最小的做法。
 *
 * 为什么分成两个 project 而不是一个：
 * - `unit` 跑纯逻辑，用 `node` 环境。启动 jsdom 需要额外开销，更关键的是它会提供
 *   浏览器全局，让「本该是纯函数」的代码悄悄依赖 DOM 而不被发现。
 * - `integration` 跑组件与 API 路由，用 `jsdom` 环境。
 * 用两个 project 表达这条边界，比在单个 project 里靠注释提醒可靠得多。
 *
 * 关于 `include`：刻意只匹配 `*.test.ts(x)`，**不**匹配 `*.spec.ts`。
 * 后者留给 Playwright 的端到端用例——两套 runner 的运行时长与依赖差异很大，
 * 一旦文件模式重叠，就会出现「跑单测却启动了浏览器」这类难以定位的问题。
 *
 * 关于 `resolve.alias`：必须与 `tsconfig.json` 的 `paths` 保持一致。
 * 被测代码（如 `app/page.tsx`）内部使用 `@/` 导入，若这里不配置别名，
 * 组件测试会在解析阶段直接失败，而不是给出与逻辑相关的失败信息。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 项目根目录。
 *
 * 由配置文件自身位置推导，而不是写死本机路径：克隆到任意目录、任意盘符都应可用。
 */
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** 路径别名，等价于 `tsconfig.json` 中的 `paths`。 */
const ALIAS = Object.freeze({
  '@': path.join(PROJECT_ROOT, 'src'),
});

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: ALIAS },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        // 只有组件/集成测试需要 JSX 转换与 DOM 环境，因此插件挂在这一层。
        plugins: [react()],
        resolve: { alias: ALIAS },
        test: {
          name: 'integration',
          environment: 'jsdom',
          include: ['tests/integration/**/*.test.ts', 'tests/integration/**/*.test.tsx'],
          setupFiles: ['tests/setup/vitest.setup.ts'],
        },
      },
    ],

    coverage: {
      provider: 'v8',
      // 覆盖率产物必须留在项目内（《开发环境规范》§2.1），不写入用户目录。
      reportsDirectory: '.cache/coverage',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}'],
      exclude: ['**/*.d.ts'],
      // 刻意不设 thresholds：P0 阶段的目标是「看得见覆盖情况」，
      // 而不是用一个尚未有人为之负责的数字卡住开发。阈值需要先有明确依据再设。
    },
  },
});
