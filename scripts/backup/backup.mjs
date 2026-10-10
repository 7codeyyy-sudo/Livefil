#!/usr/bin/env node
/**
 * 数据库备份（OPS-001，PD-2028 批 1；NFR-BACKUP-001/002）。
 *
 * ## 形态
 *
 * `pg_dump`（plain SQL，`--no-owner --no-privileges`）→ `.runtime/backups/livefil-<ts>.sql`。
 * plain 格式的取舍：便于 `restore.mjs` 用 `pg` 驱动直接执行（无需 `pg_restore`
 * 二进制），也让备份文件可读可审；5–20 用户规模下体积与恢复耗时都可忽略。
 *
 * ## pg_dump 的两条获取路径（零新依赖护栏：`pg_dump` 系统工具除外）
 *
 * 1. PATH 上有 `pg_dump` ⇒ 直连（密码经 `PGPASSWORD` env 传递，**不进 argv**——
 *    NFR-SEC-002：不回显/不暴露取值）；
 * 2. 否则 `docker exec <容器> pg_dump`（容器内本地连接，无需密码）——对齐
 *    `db-dev.mjs` 的 `livefil-pg` 开发库形态。
 *
 * ## 告警通道（OPS-001 第 2 项，开工回执裁定「日志+退出码」）
 *
 * 成功/失败各写一行**结构化 JSON 日志**（`[backup] {"event":...}`）；失败退出
 * 码非 0——cron/部署层据退出码告警，日志行供采集与排查。零新依赖。
 *
 * ## 轮转
 *
 * 保留最近 `--keep=N`（默认 10）份，更旧的自动删除——备份的价值在「有最近的
 * 一份」，无限堆积只会把磁盘故障提前。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, readdirSync, rmSync, statSync, closeSync } from 'node:fs';
import path from 'node:path';

import { PATHS } from '../env/paths.mjs';

const BACKUP_DIR = PATHS.backups;
const DEFAULT_KEEP = 10;
const PG_CONTAINER = process.env.LIVEFIL_PG_CONTAINER ?? 'livefil-pg';

function log(event, extra = {}) {
  console.log(`[backup] ${JSON.stringify({ event, ...extra })}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const keepArg = args.find((a) => a.startsWith('--keep='));
  const reasonArg = args.find((a) => a.startsWith('--reason='));
  const keep = keepArg ? Number.parseInt(keepArg.split('=')[1] ?? '', 10) : DEFAULT_KEEP;
  return {
    keep: Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_KEEP,
    reason: reasonArg ? (reasonArg.split('=')[1] ?? 'manual') : 'manual',
  };
}

/** `YYYYMMDD-HHMMSS`（UTC，文件名可排序）。 */
function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function parseDbUrl() {
  const raw = process.env.DATABASE_URL;
  if (raw === undefined || raw.trim() === '') {
    log('backup_failed', { reason: '缺少 DATABASE_URL' });
    process.exit(2);
  }
  const u = new URL(raw.trim());
  return {
    host: u.hostname,
    port: u.port === '' ? '5432' : u.port,
    user: decodeURIComponent(u.username),
    db: decodeURIComponent(u.pathname.replace(/^\//, '')),
    pass: decodeURIComponent(u.password),
  };
}

/** PATH 上是否有 pg_dump（不打印取值）。 */
function hasPathPgDump() {
  const probe = spawnSync('pg_dump', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function main() {
  const { keep, reason } = parseArgs();
  const db = parseDbUrl();
  mkdirSync(BACKUP_DIR, { recursive: true });

  const file = path.join(BACKUP_DIR, `livefil-${timestamp()}.sql`);
  const fd = openSync(file, 'w');

  let result;
  if (hasPathPgDump()) {
    // 密码只进 env（子进程环境），不进 argv（ps 可见面）。`--inserts`：以
    // INSERT 语句而非 COPY 输出——恢复侧可用单个多语句 query 原子执行（见
    // restore.mjs），5–20 用户规模下性能差异可忽略。
    result = spawnSync(
      'pg_dump',
      [
        '--no-owner',
        '--no-privileges',
        '--inserts',
        '--host',
        db.host,
        '--port',
        db.port,
        '--user',
        db.user,
        '--dbname',
        db.db,
      ],
      { stdio: ['ignore', fd, 'inherit'], env: { ...process.env, PGPASSWORD: db.pass } },
    );
  } else {
    // 容器内本地连接（socket/trust），无需密码。
    result = spawnSync(
      'docker',
      [
        'exec',
        PG_CONTAINER,
        'pg_dump',
        '-U',
        db.user,
        '--no-owner',
        '--no-privileges',
        '--inserts',
        db.db,
      ],
      { stdio: ['ignore', fd, 'inherit'] },
    );
  }
  closeSync(fd);

  if (result.status !== 0) {
    log('backup_failed', {
      reason: 'pg_dump 退出码非 0',
      exitCode: result.status,
      reason_tag: reason,
    });
    rmSync(file, { force: true });
    process.exit(1);
  }

  const bytes = statSync(file).size;
  log('backup_ok', { file: path.relative(process.cwd(), file), bytes, reason });

  // 轮转：只保留最近 keep 份（文件名含时间戳，字典序即时间序）。
  const backups = readdirSync(BACKUP_DIR)
    .filter((name) => /^livefil-\d{8}-\d{6}\.sql$/.test(name))
    .sort();
  const excess = backups.slice(0, Math.max(0, backups.length - keep));
  for (const old of excess) {
    rmSync(path.join(BACKUP_DIR, old), { force: true });
    log('rotated_out', { file: old });
  }
}

main();
