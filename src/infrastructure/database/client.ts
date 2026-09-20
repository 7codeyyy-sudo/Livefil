/**
 * 数据库连接工厂（DB-001，《详细设计说明书》§8.3「分层必填」）。
 *
 * ## 为什么缺连接串抛的是 `DEPENDENCY_UNAVAILABLE` 而不是别的
 *
 * §8.3 把必填约束**下沉到使用方**：根环境校验对 `DATABASE_URL` 保持 optional
 * （health、styleguide 与 CI 不依赖数据库，强制必填会让这些入口整体失败），
 * 真正需要的模块在使用时显式强制。这里就是数据库侧的那个点：缺配置时给出
 * 「依赖不可用（配置缺失）」——它准确地描述了"这个能力现在用不了"，且**只报
 * 变量名、不回显取值**（连接串里带密码，任何日志都不该打印它）。
 *
 * ## 为什么不加 `server-only`
 *
 * `src/shared/validation/env.server.ts` 用 `server-only` 挡住"秘密进浏览器包"，
 * 那是对的，因为它直接读 `process.env`。本模块相反：它**接收**连接串、不读环境，
 * 而且必须能被 Node 测试脚本（真机 db 测试）直接调用——`server-only` 在纯 Node
 * 环境会抛错，加了它就等于把 db 测试挡在门外。误入前端包的风险由依赖本身兜住：
 * `pg` 是 Node 专属模块，打包时就会失败。
 *
 * ## 连接池而不是单连接
 *
 * 服务端并发请求共用一个池；`max` 有上限、`connectionTimeoutMillis` 有超时
 * ——《详细设计》§6.2「所有网络调用必须有超时」同样适用于数据库连接：
 * 没有连接超时，一个不可达的数据库会让请求永远挂在"建立连接"这一步。
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { DependencyUnavailableError } from '@/shared/errors/app-error.ts';
import { createLogger } from '@/shared/telemetry/logger.ts';

import * as schema from './schema.ts';

/** 绑定好 schema 的 Drizzle 句柄。 */
export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseClientOptions {
  /**
   * 连接串。允许 `undefined` 是刻意的：调用方直接传
   * `serverEnv.databaseUrl`（它是 `string | undefined`），由本工厂统一判定缺失，
   * 避免每个调用点各写一次判空。
   */
  readonly connectionString: string | undefined;
  /** 连接池上限。 */
  readonly maxConnections?: number | undefined;
  /** 建立连接的超时（毫秒）。 */
  readonly connectionTimeoutMillis?: number | undefined;
}

export interface DatabaseClient {
  /** Drizzle 查询接口。 */
  readonly db: Database;
  /** 关闭连接池。进程退出前调用；测试的 `after` 钩子必须调用它，否则测试进程不退出。 */
  close(): Promise<void>;
}

const DEFAULT_MAX_CONNECTIONS = 10;
/** 建连超时：取 5 秒——比页面请求的 10 秒超时短，让"数据库连不上"先于"请求超时"暴露。 */
const DEFAULT_CONNECTION_TIMEOUT = 5_000;

/**
 * 创建数据库客户端。
 *
 * @param options 连接串与池参数。
 * @throws {DependencyUnavailableError} 连接串缺失或为空白时抛出。
 */
export function createDatabaseClient(options: DatabaseClientOptions): DatabaseClient {
  const connectionString = options.connectionString?.trim();

  if (connectionString === undefined || connectionString === '') {
    throw new DependencyUnavailableError('数据库连接未配置', {
      // `details` 只进脱敏日志，不进 API 响应（见 AppErrorOptions 的说明）。
      details: { variable: 'DATABASE_URL' },
    });
  }

  const pool = new Pool({
    connectionString,
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT,
  });

  // 连接池的空闲连接被服务端断开时会发出 `error`。不监听它，Node 会把这类
  // 事件当成未捕获异常直接终止进程——一个"数据库重启"就能带走整个应用。
  // 这是池的已知用法要求，不是可选的最佳实践。
  const logger = createLogger();
  pool.on('error', (error: Error) => {
    logger.error('数据库连接池发生错误', { errorMessage: error.message });
  });

  return {
    db: drizzle(pool, { schema }),
    close: async (): Promise<void> => {
      await pool.end();
    },
  };
}
