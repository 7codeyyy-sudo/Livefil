/**
 * 服务端组合根（DB-001 / IAM-001）。
 *
 * ## 职责
 *
 * 把「环境变量 → 连接/签名器 → 仓储 → 用例」这条装配链收在一处，让 route handler
 * 只表达业务流转，而不是每次都重新拼一遍依赖。集成测试注入 fake 实现时也只需要
 * 替换这一个点。
 *
 * ## 为什么在项目根，而不是 `app/_lib/`
 *
 * 组合根是**唯一**必须同时看见"抽象"与"实现"的地方——它要 import 仓储的 Drizzle
 * 实现、数据库客户端与会话签名器。而 `tests/unit/architecture/dependency-rules.ts`
 * 的「App Router 不得直接访问领域内部与基础设施」把 `app/**` 到 `src/infrastructure`
 * 与 `src/modules/<模块>/infrastructure` 的引用全部禁掉了，理由是"页面与路由不得直接
 * 访问数据库实现"。
 *
 * 这两条要求都是对的，冲突只出在位置：组合根既不是页面也不是路由，它属于架构的
 * **最外层**——按惯例与入口同级。本仓库的最外层就是项目根（`instrumentation.ts`、
 * `next.config.ts`、`proxy.ts` 都在这一层），所以它落在这里，而不去修改那条依赖规则
 * （规则本身是架构契约，改它等同于改架构）。
 *
 * `import 'server-only'` 是必须的：它保证本模块**永远不会**被打进客户端包——
 * 一旦某个客户端组件误引用它，构建会立即失败，而不是把密钥读取逻辑悄悄泄露出去。
 *
 * ## 为什么是懒加载而不是模块顶层初始化
 *
 * `next build` 会加载路由模块（用于收集与预渲染），如果这里在模块顶层就创建
 * 连接池或签名器，那么**每一次构建都需要一份完整的环境配置**——而构建静态页
 * 与 CI 根本不需要数据库。懒加载把"缺配置"的暴露时机推到真正的使用点
 * （首个请求），同时让 §8.3 的启动期检查由 `instrumentation.ts` 显式触发。
 */
import 'server-only';

import packageJson from './package.json';

import { createSessionSigner } from '@/infrastructure/auth/session-signer.ts';
import { createDatabaseClient, type DatabaseClient } from '@/infrastructure/database/client.ts';
import { createIdempotencyStore } from '@/infrastructure/idempotency/idempotency-store.drizzle.ts';
import { DEFAULT_LIFE_AREAS } from '@/modules/life-areas/domain/default-life-areas.ts';
import type { LifeAreaRepository } from '@/modules/life-areas/domain/life-area-repository.ts';
import type { LifeAreaSeed } from '@/modules/life-areas/domain/life-area.ts';
import { createLifeAreaRepository } from '@/modules/life-areas/infrastructure/life-area-repository.drizzle.ts';
import type { SessionTokenService } from '@/modules/identity/domain/session-token.ts';
import type { UserRepository } from '@/modules/identity/domain/user-repository.ts';
import { createUserRepository } from '@/modules/identity/infrastructure/user-repository.drizzle.ts';
import type { GoalRepository, ActionRepository } from '@/modules/goals/domain/goal-repository.ts';
import {
  createActionRepository,
  createGoalRepository,
} from '@/modules/goals/infrastructure/goal-repository.drizzle.ts';
import type { TaskRepository } from '@/modules/tasks/domain/task-repository.ts';
import { createTaskRepository } from '@/modules/tasks/infrastructure/task-repository.drizzle.ts';
import { createAuditLogger, type AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { serverEnv } from '@/shared/validation/env.server.ts';

/**
 * 审计事件里的应用版本（SRS §6.7 要求）。
 *
 * 直接读 `package.json` 而不是手写字符串：手写的版本号在每次发版时都要有人记得
 * 同步，而"审计事件带着一个过期的版本"恰恰会让它在排查时误导人。等发布流程有了
 * 构建期注入，这里换成读取注入值即可，调用点不变。
 */
const APP_VERSION: string = packageJson.version;

let databaseClient: DatabaseClient | null = null;
let sessionTokenService: SessionTokenService | null = null;
let auditLogger: AuditLogger | null = null;

/** 数据库客户端单例。缺 `DATABASE_URL` 时由连接工厂抛出 `DEPENDENCY_UNAVAILABLE`。 */
function getDatabaseClient(): DatabaseClient {
  databaseClient ??= createDatabaseClient({ connectionString: serverEnv.databaseUrl });
  return databaseClient;
}

/**
 * 会话令牌服务单例。
 *
 * `instrumentation.ts` 在启动时调用一次本函数，让缺密钥的部署**启动即失败**
 * （§8.3：装配期暴露，而不是首个请求才暴露）。
 *
 * 返回类型是领域端口而不是具体实现：调用方（应用层与 API 适配层）只该知道
 * "有人能签发与验证会话"，不该知道它是 HMAC。
 */
export function getSessionTokenService(): SessionTokenService {
  sessionTokenService ??= createSessionSigner({ secret: serverEnv.authSecret });
  return sessionTokenService;
}

/** 首启播种用的领域名单（归属 `life-areas` 领域，这里只是转交）。 */
export function getLifeAreaSeeds(): readonly LifeAreaSeed[] {
  return DEFAULT_LIFE_AREAS;
}

/** 审计日志器单例（SRS §6.7 的 6 类事件经它写出，与运行日志共用脱敏规则）。 */
export function getAuditLogger(): AuditLogger {
  auditLogger ??= createAuditLogger({ appVersion: APP_VERSION });
  return auditLogger;
}

/**
 * 仓储集合。
 *
 * 返回类型显式写出来（而不是让 TS 从两个 `create*Repository` 的返回推断）：仓储
 * 的具体类型里带着 Drizzle 的行类型，把它暴露给调用方等于把持久化细节漏出去。
 * 显式标注成领域端口后，**实现替换不会改变调用方的类型**——这正是端口存在的意义。
 */
export function getRepositories(): {
  readonly users: UserRepository;
  readonly lifeAreas: LifeAreaRepository;
  readonly tasks: TaskRepository;
  readonly goals: GoalRepository;
  readonly actions: ActionRepository;
} {
  const db = getDatabaseClient().db;
  return {
    users: createUserRepository(db),
    lifeAreas: createLifeAreaRepository(db),
    tasks: createTaskRepository(db),
    goals: createGoalRepository(db),
    actions: createActionRepository(db),
  };
}

/**
 * 幂等存储单例（TASK-001 / DB §4.15）。
 *
 * 返回的端口类型在 `app/_lib/idempotency.ts`（消费方所有）——组合根在这里做
 * 结构赋值检查，基础设施不必为了满足消费方的接口而反向 import。
 */
export function getIdempotencyStore() {
  return createIdempotencyStore(getDatabaseClient().db);
}

/** 进程退出前关闭连接池（测试与脚本用；route handler 不需要调用）。 */
export async function closeDatabase(): Promise<void> {
  if (databaseClient !== null) {
    await databaseClient.close();
    databaseClient = null;
  }
}
