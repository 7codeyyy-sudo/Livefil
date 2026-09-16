/**
 * MSW Node 侧服务端（FND-003）。
 *
 * 边界（刻意划清，避免 MSW 变成什么都拦的万能层）：
 * - **只在 Node 侧测试中使用**。不启用浏览器端的 `setupWorker`：
 *   前端回归由集成测试覆盖即可，再加一层浏览器拦截只会让失败原因更难定位。
 * - **不作为 E2E 的拦截手段**。E2E 一律使用 Playwright 的 `page.route()`，
 *   被测的是真实的 HTTP 往返，不该在浏览器里替换掉网络层。
 * - **不替代依赖注入**。可注入的领域依赖仍应由调用方传入；
 *   MSW 只用于处理「必须走真实 HTTP 客户端」的那部分代码。
 *
 * 用法（在测试文件顶层调用一次）：
 *
 * ```ts
 * enableMswServer();
 *
 * it('接口失败时展示错误态', async () => {
 *   server.use(http.get('/api/v1/health', () => HttpResponse.json({}, { status: 500 })));
 *   // ...
 * });
 * ```
 */
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

/**
 * 共享的 MSW 服务端。
 *
 * 不在模块加载时自动启动：`beforeAll` 之类的生命周期钩子必须在测试文件的收集阶段
 * 由测试文件自己注册，模块副作用注册会让「这个文件是否使用 MSW」变得不可见。
 */
export const server = setupServer();

/**
 * 为当前测试文件启用 MSW 拦截。
 *
 * 必须在测试文件顶层调用。
 *
 * 命名刻意**不用** `use` 前缀：`react-hooks/rules-of-hooks` 会把任何 `useXxx()`
 * 形式的顶层调用判定为 Hook 误用。这里的「启用」是测试生命周期注册、与 React 无关，
 * 换个前缀比在 lint 配置里为它开例外更干净——例外一旦开了，就会掩盖真正的 Hook 误用。
 */
export function enableMswServer(): void {
  beforeAll(() => {
    server.listen({
      // 未被任何 handler 覆盖的请求直接失败，而不是放行到真实网络。
      // 静默放行会让测试在「以为接口被 mock 了」的假设下依赖真实服务，
      // 一旦服务不可用就表现为随机失败。
      onUnhandledRequest: 'error',
    });
  });

  afterEach(() => {
    // 每个用例重置 handler，避免 `server.use()` 的临时覆盖泄漏到后续用例。
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });
}
