import { defineConfig } from 'drizzle-kit';

import { parseServerEnv } from './src/shared/validation/env.ts';

/**
 * Drizzle Kit 配置（DB-001，《详细设计说明书》§11）。
 *
 * ## 为什么复用应用的环境变量校验
 *
 * `parseServerEnv` 是环境变量规则的**唯一定义源**（FND-001）：连接串必须是
 * `postgres:` / `postgresql:` 协议、校验失败只报变量名不回显取值。迁移工具另起
 * 一套读取逻辑，就会让"应用认为配置合法、迁移工具认为不合法"这类分歧有机会出现。
 *
 * ## `dbCredentials` 的哨兵值
 *
 * `drizzle-kit generate` **不连接数据库**（它只读 schema 生成 SQL），但配置对象
 * 里必须有 `url`。缺 `DATABASE_URL` 时给一个一眼可辨的哨兵，真正的拦截放在
 * `scripts/env/db.mjs` 里：只有 `migrate` / `test` 才要求真实连接串，且缺失时
 * 报的是我们自己写的明确错误——而不是驱动抛出的、语义含糊的 URL 解析失败
 * （《详细设计》§8.3 明确要求这一点）。
 */
const env = parseServerEnv(process.env);

export default defineConfig({
  schema: './drizzle/schema.ts',
  /** 迁移产物与 schema 同目录：`drizzle/0000_*.sql` + `drizzle/meta/`（§2 的目录契约）。 */
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: env.databaseUrl ?? 'postgresql://unconfigured' },
  /** 生成迁移前要求确认（避免误改已入库的迁移）。 */
  strict: true,
  verbose: true,
});
