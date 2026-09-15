/**
 * Next.js 服务端启动钩子（FND-001）。
 *
 * `register()` 在每次服务端实例启动时执行一次，覆盖 `next dev` 与 `next start`：
 * 非法环境变量会在启动阶段就明确失败，而不是等到某个请求才暴露（FND-001 验收要求）。
 *
 * 只有显式运行在 edge 运行时时才跳过校验——edge 运行时读不到这些服务端变量。
 * 采用「排除 edge」而非「仅 nodejs」是为了在运行时不明确时仍然执行校验，
 * 避免校验被静默跳过。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') {
    return;
  }

  // 动态导入：把校验严格限制在服务端运行时，不进入客户端依赖图。
  await import('./src/shared/validation/env.server');

  // 只输出结论，不输出任何环境变量取值（开发环境规范 §4）。
  console.log('[livefil] 服务端环境变量校验通过。');
}
