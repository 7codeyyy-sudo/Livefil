/**
 * 客户端组合根（SYNC-002 / SYNC-003）。
 *
 * ## 职责
 *
 * 把「浏览器能力 → 本地存储实现」这一个装配点收在一处，让上层的同步引擎与
 * `api-client` 只看见 `LocalStore` 端口，而不是"IndexedDB 还是内存"。
 *
 * ## 为什么另起一个根文件，而不是扩 `composition-root.ts`
 *
 * `composition-root.ts` 带 `import 'server-only'`：它的存在本身就是为了保证
 * 服务端配置与数据库客户端**永远不会**被打进客户端包。客户端需要一个同样位置、
 * 但方向相反的装配点，两者不能合并——合并的结果只能是二选一地丢掉其中一条保证。
 *
 * 放在项目根的理由与服务端那份完全相同：组合根是唯一必须同时看见"抽象"与
 * "实现"的地方，而 `tests/unit/architecture/dependency-rules.ts` 的「App Router
 * 不得直接访问领域内部与基础设施」把 `app` 下一切到各模块 `infrastructure` 的
 * 引用全部禁掉了。根目录不是页面也不是路由——它属于架构的最外层，与本仓库的
 * `composition-root.ts`、`instrumentation.ts`、`next.config.ts` 同级。
 *
 * ## 为什么按环境回退到内存实现
 *
 * `indexedDB` 在 Node（SSR / `next build` 的预渲染）与 jsdom（单测）里都不存在。
 * 这里不做"检测不到就抛错"，而是回退到内存实现：SSR 期间同步状态本就按"无待同步项"
 * 渲染（`SyncClient.getServerSnapshot`），内存实现足以让这条路径不炸；真正的持久化
 * 只会发生在浏览器里。
 */
import type { LocalStore } from '@/modules/sync/domain/local-store.ts';
import { createIndexedDbLocalStore } from '@/modules/sync/infrastructure/local-store.indexeddb.ts';
import { createMemoryLocalStore } from '@/modules/sync/infrastructure/local-store.memory.ts';

let localStore: LocalStore | null = null;

/**
 * 本地存储单例。
 *
 * 懒建的原因：模块顶层创建会在 `next build` 收集路由时就执行，而此时既没有
 * 浏览器环境、也没有任何真实需求——把装配推迟到首次使用点，构建产物与静态
 * 预渲染就都不必经过这条路径。
 */
export function getLocalStore(): LocalStore {
  localStore ??=
    typeof indexedDB === 'undefined' ? createMemoryLocalStore() : createIndexedDbLocalStore();
  return localStore;
}
