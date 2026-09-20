/**
 * Phase 2 真机数据库测试（DB-001）。
 *
 * ## 这一层专门验什么
 *
 * 只验**数据库自己提供、内存假仓储无法证明**的那些保证：
 * 空库迁移能否跑通、默认值是否如约、外键是否真的拦住、以及两条部分唯一索引
 * 是否真的让"并发首启"和"归档项不占名字"成立。仓储与用例的行为由
 * `tests/integration/**` 用假仓储覆盖（那部分不需要数据库）。
 *
 * 这也是为什么本文件用**原生 SQL** 而不是 import 项目的仓储：
 * 项目源文件使用 `@/` 路径别名，纯 Node 无法解析（vitest 里可以，但 vitest 的两个
 * project 刻意不依赖数据库）。用原生 SQL 反而让这一层验得更"贴底"——它断言的是
 * 数据库约束本身，不管上层怎么拼查询。
 *
 * ## 运行
 *
 * `npm run db:test`（由 `scripts/env/db.mjs` 驱动，需 `TEST_DATABASE_URL`）。
 * 它会**清空测试库**，所以要指向一个专用库，别指向开发库。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { PROJECT_ROOT } from '../../scripts/env/paths.mjs';

/** 唯一本地用户的判据（与 `user-repository.drizzle.ts` 的 `LOCAL_MODE` 一致）。 */
const LOCAL_MODE = 'local';

/** 插入一个用户所需的最小字段（`timezone` 无数据库默认值，必须显式给）。 */
const INSERT_USER = 'INSERT INTO users (mode, timezone) VALUES ($1, $2)';

let pool;

before(async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(
    typeof connectionString === 'string' && connectionString.trim() !== '',
    '本测试需要 TEST_DATABASE_URL（由 npm run db:test 注入）',
  );

  pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000, max: 4 });

  // 空库重来：把两个 schema 一起丢掉。只丢 `public` 是不够的——drizzle 的迁移
  // 记录存在 `drizzle` schema 里，留着它就会认为"已经迁过了"，于是空库上根本
  // 不建表，测试却以为自己验的是迁移后的状态。
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('CREATE SCHEMA public');

  await migrate(drizzle(pool), { migrationsFolder: path.join(PROJECT_ROOT, 'drizzle') });
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  // `CASCADE` 会连带清空 life_areas（外键指向 users）。
  await pool.query('TRUNCATE users CASCADE');
});

test('迁移在空库上建出两张表与全部索引', async () => {
  const tables = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    ['life_areas', 'users'],
  );

  const indexes = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname",
  );
  const names = indexes.rows.map((row) => row.indexname);
  for (const expected of [
    'life_areas_user_active_name_unique',
    'life_areas_user_sort_idx',
    'users_single_local_unique',
  ]) {
    assert.ok(names.includes(expected), `迁移后应存在索引 ${expected}`);
  }
});

test('用户默认值与《数据库设计文档》§4.1 一致', async () => {
  const inserted = await pool.query(
    `${INSERT_USER} RETURNING locale, currency_code, week_starts_on, reminder_enabled, ai_enabled, ai_data_consent, version, quiet_hours_start`,
    [LOCAL_MODE, 'Asia/Shanghai'],
  );
  const row = inserted.rows[0];

  assert.equal(row.locale, 'zh-CN');
  assert.equal(row.currency_code, 'CNY');
  assert.equal(row.week_starts_on, 1);
  // 提醒默认开启（SRS 的默认偏好），而 AI 默认关闭且未同意。
  assert.equal(row.reminder_enabled, true);
  assert.equal(row.ai_enabled, false);
  assert.equal(row.ai_data_consent, false);
  // `version` 是 `bigint`，而 `pg` 出于防 int8 精度丢失的考虑**默认不转换**，
  // 按字符串返回（这里拿到的是 `'1'`）——不显式转换的话断言恒假，
  // 失败信息还会误导成"默认值没生效"。
  // 产品路径不受影响：Drizzle 声明了 `mode: 'number'`，仓储读到的是 number
  // （真机全链路的 `/me` 响应里 `version` 是数字，已实测）。
  assert.equal(Number(row.version), 1);
  assert.equal(row.quiet_hours_start, null);
});

test('生活领域的外键指向用户，且级联删除', async () => {
  await assert.rejects(
    () =>
      pool.query(
        "INSERT INTO life_areas (user_id, name, color_key, sort_order) VALUES (gen_random_uuid(), '工作', 'blue', 0)",
      ),
    (error) => error.code === '23503',
  );

  const user = await pool.query(`${INSERT_USER} RETURNING id`, [LOCAL_MODE, 'Asia/Shanghai']);
  const userId = user.rows[0].id;
  await pool.query(
    "INSERT INTO life_areas (user_id, name, color_key, sort_order) VALUES ($1, '工作', 'blue', 0)",
    [userId],
  );

  await pool.query('DELETE FROM users WHERE id = $1', [userId]);

  const remaining = await pool.query('SELECT count(*)::int AS n FROM life_areas');
  assert.equal(remaining.rows[0].n, 0);
});

test('至多一个本地用户（部分唯一索引真的生效）', async () => {
  await pool.query(INSERT_USER, [LOCAL_MODE, 'Asia/Shanghai']);

  await assert.rejects(
    () => pool.query(INSERT_USER, [LOCAL_MODE, 'Asia/Shanghai']),
    (error) => error.code === '23505',
  );
});

test('该索引只约束 local，多用户模式下不误伤', async () => {
  // 云端批次会有多个 mode='cloud' 的用户，索引的 WHERE 子句必须把它们排除在外。
  await pool.query(INSERT_USER, ['cloud', 'Asia/Shanghai']);
  await pool.query(INSERT_USER, ['cloud', 'Europe/London']);

  const counted = await pool.query("SELECT count(*)::int AS n FROM users WHERE mode = 'cloud'");
  assert.equal(counted.rows[0].n, 2);
});

test('并发首启只产生一个本地用户', async () => {
  const first = await pool.connect();
  const second = await pool.connect();

  try {
    await first.query('BEGIN');
    await first.query(INSERT_USER, [LOCAL_MODE, 'Asia/Shanghai']);

    await second.query('BEGIN');
    // 第二个插入会**阻塞**在唯一索引上，直到第一个事务提交或回滚——
    // 这正是"两个进程同时首启"的形态。`SELECT ... FOR UPDATE` 挡不住它
    // （空结果集不加锁），只有索引能。
    const blocked = second.query(INSERT_USER, [LOCAL_MODE, 'Asia/Shanghai']);
    const outcome = blocked.then(
      () => 'inserted',
      (error) => error.code,
    );

    await first.query('COMMIT');

    assert.equal(await outcome, '23505', '并发的第二个插入应撞唯一索引而不是成功');
    await second.query('ROLLBACK');
  } finally {
    first.release();
    second.release();
  }

  const counted = await pool.query("SELECT count(*)::int AS n FROM users WHERE mode = 'local'");
  assert.equal(counted.rows[0].n, 1);
});

test('归档项不占名字（部分唯一索引只作用于未归档）', async () => {
  const user = await pool.query(`${INSERT_USER} RETURNING id`, [LOCAL_MODE, 'Asia/Shanghai']);
  const userId = user.rows[0].id;
  const insertArea = (name, archived) =>
    pool.query(
      'INSERT INTO life_areas (user_id, name, color_key, sort_order, is_archived) VALUES ($1, $2, $3, 0, $4)',
      [userId, name, 'blue', archived],
    );

  await insertArea('工作', false);

  // 同名未归档 → 冲突（靠索引而不是先查后插，避免两个请求同时通过预检）。
  await assert.rejects(
    () => insertArea('工作', false),
    (error) => error.code === '23505',
  );

  // 归档它，然后同名可以再建：归档不等于"这个名字被永久占用"。
  await pool.query(
    "UPDATE life_areas SET is_archived = true WHERE user_id = $1 AND name = '工作'",
    [userId],
  );
  await insertArea('工作', false);

  const counted = await pool.query('SELECT count(*)::int AS n FROM life_areas WHERE user_id = $1', [
    userId,
  ]);
  assert.equal(counted.rows[0].n, 2);
});

test('事务回滚后排序值不变（重排要么全部生效、要么全部不变）', async () => {
  const user = await pool.query(`${INSERT_USER} RETURNING id`, [LOCAL_MODE, 'Asia/Shanghai']);
  const userId = user.rows[0].id;
  const area = await pool.query(
    "INSERT INTO life_areas (user_id, name, color_key, sort_order) VALUES ($1, '工作', 'blue', 0) RETURNING id",
    [userId],
  );
  const areaId = area.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE life_areas SET sort_order = 99 WHERE id = $1', [areaId]);
    await client.query('ROLLBACK');

    const after = await client.query('SELECT sort_order FROM life_areas WHERE id = $1', [areaId]);
    assert.equal(after.rows[0].sort_order, 0);
  } finally {
    client.release();
  }
});
