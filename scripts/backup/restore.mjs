#!/usr/bin/env node
/**
 * 数据库恢复到临时库 + 行数比对（OPS-001 第 4 项**恢复演练**的执行器，PD-028 批 1）。
 *
 * ## 为什么不直接覆盖源库
 *
 * 演练的目标是**证明备份可恢复**，不是真的毁掉现网数据。因此恢复到一个
 * **临时库**（默认 `livefil_restore_drill`）：DROP + CREATE → 执行备份 SQL →
 * 与源库逐表比对行数。全匹配 ⇒ 备份有效；任何差异 ⇒ 退出码非 0。
 *
 * ## 恢复方式
 *
 * 备份为 `pg_dump --inserts`（plain + INSERT 语句），可作为**单个多语句 query**
 * 在一个隐式事务里原子执行——无需 `pg_restore` 二进制（零新依赖）。
 *
 * ## 用法
 *
 *   node scripts/backup/restore.mjs                     # 最新备份 → 临时库
 *   node scripts/backup/restore.mjs --file=<sql>        # 指定备份
 *   node scripts/backup/restore.mjs --target=<库名>     # 指定目标库
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import pg from 'pg';

import { PATHS } from '../env/paths.mjs';

const BACKUP_DIR = PATHS.backups;
const DEFAULT_TARGET = 'livefil_restore_drill';
const PG_CONTAINER = process.env.LIVEFIL_PG_CONTAINER ?? 'livefil-pg';

function log(event, extra = {}) {
  console.log(`[restore] ${JSON.stringify({ event, ...extra })}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => a.startsWith('--file='));
  const targetArg = args.find((a) => a.startsWith('--target='));
  return {
    file: fileArg ? (fileArg.split('=')[1] ?? '') : '',
    target: targetArg ? (targetArg.split('=')[1] ?? '') || DEFAULT_TARGET : DEFAULT_TARGET,
  };
}

/** 读 .env.local 或 process.env 的 DATABASE_URL（不回显取值）。 */
function resolveDbUrl() {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  const envLocal = path.join(process.cwd(), '.env.local');
  if (existsSync(envLocal)) {
    const m = readFileSync(envLocal, 'utf8').match(/^DATABASE_URL=(.+)$/m);
    if (m?.[1] !== undefined) {
      return m[1].trim();
    }
  }
  log('restore_failed', { reason: '缺少 DATABASE_URL' });
  process.exit(2);
}

/** 最新备份文件（文件名含时间戳，字典序即时间序）。 */
function latestBackup() {
  if (!existsSync(BACKUP_DIR)) {
    return '';
  }
  const files = readdirSync(BACKUP_DIR)
    .filter((n) => /^livefil-\d{8}-\d{6}\.sql$/.test(n))
    .sort();
  return files.at(-1) ?? '';
}

async function main() {
  const { file: fileArg, target } = parseArgs();
  const dbUrl = resolveDbUrl();
  const fileName = fileArg === '' ? latestBackup() : fileArg;
  if (fileName === '') {
    log('restore_failed', { reason: '没有可用的备份文件' });
    process.exit(2);
  }
  const filePath = path.isAbsolute(fileName) ? fileName : path.join(BACKUP_DIR, fileName);
  if (!existsSync(filePath)) {
    log('restore_failed', { reason: '备份文件不存在', file: fileName });
    process.exit(2);
  }

  // admin 连接（建/删目标库）与源库连接（比对）。
  const adminUrl = new URL(dbUrl);
  adminUrl.pathname = '/postgres';
  const sourceUrl = new URL(dbUrl);
  const targetUrl = new URL(dbUrl);
  targetUrl.pathname = `/${target}`;

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${target}`);
  await admin.query(`CREATE DATABASE ${target}`);
  await admin.end();
  log('target_recreated', { target });

  const sql = readFileSync(filePath, 'utf8');
  const started = Date.now();

  // 执行备份 SQL：优先 `docker exec -i psql`（stdin 灌入）。
  //
  // PG17 的 `pg_dump` 会在输出里插入 `\restrict`/`\unrestrict` **psql 元命令**
  // （恢复时的安全限制）——`psql` 识别它们，而 `node:pg` 的 `query()` 会把
  // `\...` 当作 SQL 报 `syntax error at or near "\"`。目标库在容器内，
  // `psql` 是最可靠的恢复通道（完全兼容 dump 输出）。
  const user = decodeURIComponent(new URL(dbUrl).username);
  const psql = spawnSync(
    'docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', user, '-d', target, '-v', 'ON_ERROR_STOP=1', '-q'],
    { input: sql, stdio: ['pipe', 'inherit', 'inherit'] },
  );

  const restored = new pg.Client({ connectionString: targetUrl.toString() });
  await restored.connect();
  if (psql.status === 0) {
    log('restore_executed', { via: 'psql', target, ms: Date.now() - started, bytes: sql.length });
  } else {
    // fallback：无 docker/psql 时用 node:pg 执行——**剥离 psql 元命令行**（`\...`），
    // 其余为纯 SQL。仅在容器不可达的环境触发。
    const cleaned = sql
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('\\'))
      .join('\n');
    await restored.query(cleaned);
    log('restore_executed', {
      via: 'node-pg',
      target,
      ms: Date.now() - started,
      bytes: cleaned.length,
    });
  }

  // 表清单（源库 public）。
  const source = new pg.Client({ connectionString: sourceUrl.toString() });
  await source.connect();
  const tablesRes = await source.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const tables = tablesRes.rows.map((r) => r.tablename);

  let matched = 0;
  const mismatched = [];
  for (const t of tables) {
    const s = await source.query(`SELECT count(*)::int AS c FROM "${t}"`);
    const r = await restored.query(`SELECT count(*)::int AS c FROM "${t}"`);
    const sc = s.rows[0]?.c ?? -1;
    const rc = r.rows[0]?.c ?? -1;
    if (sc === rc) {
      matched += 1;
    } else {
      mismatched.push({ table: t, source: sc, restored: rc });
    }
  }

  await source.end();
  await restored.end();

  if (mismatched.length > 0) {
    log('drill_failed', { matched, mismatched });
    process.exit(1);
  }
  log('drill_ok', { tables: tables.length, matched, note: '全部表行数一致——备份可恢复' });

  // 清理临时库（演练完成即弃；真实灾难恢复不会走这条路径）。
  const cleanup = new pg.Client({ connectionString: adminUrl.toString() });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS ${target}`);
  await cleanup.end();
  log('target_cleaned', { target });
}

main().catch((error) => {
  log('restore_failed', { reason: String(error?.message ?? error) });
  process.exit(1);
});
