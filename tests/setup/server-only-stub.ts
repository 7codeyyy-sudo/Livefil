/**
 * `server-only` 的测试环境空桩。
 *
 * ## 为什么需要它
 *
 * `server-only` 包的机制是：客户端构建解析到 `index.js`（import 即抛错），
 * 服务端构建（`react-server` 导出条件）解析到 `empty.js`（空实现）——
 * 由此让「服务端模块误入客户端包」在构建期直接失败。
 *
 * 但 vitest 既不是客户端也不是 RSC 编译，不带 `react-server` 条件，
 * 于是解析到抛错的 `index.js`。任何被测模块只要 import 链上碰了
 * `env.server` 或 `composition-root`（两者都 `import 'server-only'`），
 * 测试进程就会在模块加载阶段直接崩在这里。
 *
 * 在 vitest 的 alias 里把它钉到本空文件：测试环境本来就没有「客户端包」，
 * 这道防线没有可防之物；拦下来的是测试，不是事故。
 *
 * 真正的客户端误引防线由 `next build` 承担（构建期失败），不在本桩职责内。
 */
export {};
