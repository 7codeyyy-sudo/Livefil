/**
 * Playwright 配置（FND-003）。
 *
 * 关键约定：
 * - 用例文件是 `*.spec.ts`，与 Vitest 的 `*.test.ts(x)` 完全互斥，
 *   避免「跑单测却启动浏览器」或「跑 E2E 却撞上单元测试」这类互相污染。
 * - 所有产物（报告、截图、trace、结果目录）一律落在项目内 `.cache/playwright/` 下，
 *   不写入用户目录，也不会污染项目根（《开发环境规范》§2.1）。
 * - 浏览器本体的安装位置由 `PLAYWRIGHT_BROWSERS_PATH` 控制，
 *   在 `scripts/env/paths.mjs` 的 `projectEnv()` 中统一注入。
 */
import { defineConfig, devices } from '@playwright/test';

/** E2E 专用端口。与开发默认端口错开，避免本机已开着 dev server 时互相抢占。 */
const E2E_PORT = 3210;

/** 构建并启动服务器的最长等待时间。冷缓存下 Next 首次构建可能接近两分钟。 */
const WEB_SERVER_TIMEOUT_MS = 300_000;

/** 项目内测试产物根目录（已被 `.gitignore`、`.prettierignore` 与 ESLint 忽略）。 */
const ARTIFACTS_ROOT = '.cache/playwright';

/** E2E 服务地址。用 127.0.0.1 而非 localhost，避免 IPv6/IPv4 解析差异拖慢首次连接。 */
const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * 具名设备的描述符类型。
 *
 * `devices` 在类型上是字符串索引签名，开启 `noUncheckedIndexedAccess` 后索引结果
 * 含 `undefined`；这里把它收敛成确定值，避免在配置里散落非空断言。
 */
type ResolvedDevice = NonNullable<(typeof devices)[string]>;

/**
 * 取内置设备描述符；名称拼错时立即失败。
 *
 * @param name Playwright 内置设备名，如 `Desktop Chrome`。
 * @returns 设备描述符。
 * @throws {Error} 名称不存在时抛出——拼写错误应让配置加载失败，而不是静默退化成默认视口，
 *   否则「移动端没被测到」这种问题会一直到线上才被发现。
 */
function resolveDevice(name: string): ResolvedDevice {
  const descriptor = devices[name];
  if (descriptor === undefined) {
    throw new Error(`未找到名为「${name}」的 Playwright 内置设备，请检查名称拼写`);
  }
  return descriptor;
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',

  // E2E 用例共享同一个服务器与（未来的）数据库，并行会互相干扰，固定单 worker。
  fullyParallel: false,
  workers: 1,

  // 本地允许 `test.only` 便于调试；CI 下必须拦下，否则会静默跳过其余用例。
  forbidOnly: process.env.CI !== undefined,
  retries: 0,

  reporter: [['list'], ['html', { outputFolder: `${ARTIFACTS_ROOT}/report`, open: 'never' }]],
  outputDir: `${ARTIFACTS_ROOT}/test-results`,

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'desktop-chromium', use: { ...resolveDevice('Desktop Chrome') } },
    { name: 'mobile-chromium', use: { ...resolveDevice('Pixel 5') } },
  ],

  webServer: {
    // 先构建再启动：`next start` 需要 `.next` 产物，直接跑会失败。
    command: `npm run build && npm run start -- --port ${E2E_PORT}`,
    url: BASE_URL,
    // 本地复用已在运行的服务器可以省下一次构建；CI 下必须每次全新构建，
    // 否则可能测到上一次的产物。
    reuseExistingServer: process.env.CI === undefined,
    timeout: WEB_SERVER_TIMEOUT_MS,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
