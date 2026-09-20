#!/usr/bin/env node
/**
 * 本地 PostgreSQL 开发实例（DB-001）。
 *
 * ## 为什么用脚本而不是让你手敲 docker 命令
 *
 * 《开发环境规范》§3.3 对本地数据库有两条硬要求：**数据卷必须映射到项目目录**、
 * 不得把真实用户数据写进本地开发库。手敲命令时这两条最容易丢——`docker run`
 * 一旦漏掉 `-v`，数据就跑进 Docker 的默认卷里，既不透明也不随项目走。
 * 脚本把数据目录固定在 `.runtime/pgdata`（与 §5 的 `.runtime/logs|exports|backups` 同族），
 * 路径由 `PROJECT_ROOT` 在运行时算出，**代码里没有也没有必要有绝对路径**。
 *
 * ## 它建两个库
 *
 * `livefil`（开发）与 `livefil_test`（真机测试）。真机数据库测试会做**空库迁移**
 * 与**事务回滚**，拿开发库当靶子等于把开发数据洗一遍。
 *
 * ## 凭据
 *
 * 全部是本地开发用的固定弱值，只监听 `127.0.0.1`、只在本机可用。它们**不是秘密**，
 * 也**不得**被复制到任何其他环境（这也是脚本敢把它们打印出来的原因——运维侧的
 * 真实连接串永远不该出现在日志里，见《开发环境规范》§4）。
 *
 * 用法：
 *   node scripts/env/db-dev.mjs up       # 启动（不存在则创建），等待就绪并打印连接串
 *   node scripts/env/db-dev.mjs down     # 停止容器，保留数据目录
 *   node scripts/env/db-dev.mjs status   # 查看状态
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { PROJECT_ROOT, formatPath } from './paths.mjs';

const CONTAINER_NAME = 'livefil-pg';
const DEV_DATABASE = 'livefil';
const TEST_DATABASE = 'livefil_test';
const DB_USER = 'livefil';
const DB_PASSWORD = 'livefil_local_dev';

/** 数据目录：项目内，随项目走。 */
const DATA_DIR = path.join(PROJECT_ROOT, '.runtime', 'pgdata');

/** 默认端口避开 5432：本机可能已有别的 PostgreSQL，抢端口只会让人困惑。 */
const PORT = process.env.LIVEFIL_PG_PORT ?? '55432';

/** 镜像可用环境变量覆盖：不同机器上已有的版本可能不同，不强制拉取特定 tag。 */
const IMAGE = process.env.LIVEFIL_PG_IMAGE ?? 'postgres:17-alpine';

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...options });
}

/** Docker 引擎是否可达。CLI 存在但引擎没起是最常见的失败原因，值得单独判。 */
function assertDockerAvailable() {
  const result = docker(['info', '--format', '{{.ServerVersion}}']);
  if (result.status !== 0) {
    console.error(
      '[db-dev] 无法连接 Docker 引擎。若使用 Docker Desktop，请先启动它。\n' +
        `         （CLI 报错：${(result.stderr ?? '').trim().split('\n')[0] ?? '未知'}）`,
    );
    process.exit(1);
  }
}

function containerState() {
  const result = docker([
    'ps',
    '-a',
    '--filter',
    `name=^${CONTAINER_NAME}$`,
    '--format',
    '{{.State}}',
  ]);
  const state = (result.stdout ?? '').trim();
  return state === '' ? 'absent' : state;
}

function connectionUrl(database) {
  return `postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${PORT}/${database}`;
}

/** 等待数据库可用：容器 running 不等于 PostgreSQL 已接受连接。 */
async function waitUntilReady(attempts = 30) {
  const { default: pg } = await import('pg');

  for (let index = 0; index < attempts; index += 1) {
    const client = new pg.Client({
      connectionString: connectionUrl(DEV_DATABASE),
      connectionTimeoutMillis: 1000,
    });
    try {
      await client.connect();
      await client.end();
      return true;
    } catch {
      // 还没起来是预期内的；这里刻意不打印每次失败，否则首次拉镜像时会刷屏。
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return false;
}

function ensureTestDatabase() {
  // 已存在时报错属正常（`CREATE DATABASE` 不支持 IF NOT EXISTS），只看结果。
  docker([
    'exec',
    CONTAINER_NAME,
    'psql',
    '-U',
    DB_USER,
    '-d',
    DEV_DATABASE,
    '-c',
    `CREATE DATABASE ${TEST_DATABASE} OWNER ${DB_USER}`,
  ]);
}

async function start() {
  assertDockerAvailable();

  const state = containerState();
  if (state === 'running') {
    console.log(`[db-dev] 容器 ${CONTAINER_NAME} 已在运行`);
  } else if (state === 'exited' || state === 'created' || state === 'paused') {
    console.log(`[db-dev] 启动既有容器 ${CONTAINER_NAME}`);
    const started = docker(['start', CONTAINER_NAME]);
    if (started.status !== 0) {
      console.error(`[db-dev] 启动失败：${(started.stderr ?? '').trim()}`);
      process.exit(1);
    }
  } else {
    console.log(`[db-dev] 创建容器 ${CONTAINER_NAME}（镜像 ${IMAGE}）`);
    console.log(`[db-dev] 数据目录 ${formatPath(DATA_DIR)}`);
    const created = docker([
      'run',
      '-d',
      '--name',
      CONTAINER_NAME,
      '-e',
      `POSTGRES_USER=${DB_USER}`,
      '-e',
      `POSTGRES_PASSWORD=${DB_PASSWORD}`,
      '-e',
      `POSTGRES_DB=${DEV_DATABASE}`,
      // 只绑本机回环，不暴露到局域网。
      '-p',
      `127.0.0.1:${PORT}:5432`,
      // 数据卷映射到项目目录（§3.3 的硬要求）。
      '-v',
      `${DATA_DIR}:/var/lib/postgresql/data`,
      IMAGE,
    ]);
    if (created.status !== 0) {
      console.error(`[db-dev] 创建失败：${(created.stderr ?? '').trim()}`);
      process.exit(1);
    }
  }

  const ready = await waitUntilReady();
  if (!ready) {
    console.error(
      '[db-dev] 等待数据库就绪超时。可用 `docker logs ' + CONTAINER_NAME + '` 查看原因。',
    );
    process.exit(1);
  }

  ensureTestDatabase();

  console.log('');
  console.log('[db-dev] 已就绪。以下凭据仅供本地开发，请勿复制到任何其他环境：');
  console.log(`  DATABASE_URL=${connectionUrl(DEV_DATABASE)}`);
  console.log(`  TEST_DATABASE_URL=${connectionUrl(TEST_DATABASE)}`);
  console.log('');
  console.log('把它们写入项目根的 .env.local（该文件已被 .gitignore 忽略）。');
}

function stop() {
  assertDockerAvailable();
  const result = docker(['stop', CONTAINER_NAME]);
  if (result.status === 0) {
    console.log(`[db-dev] 已停止 ${CONTAINER_NAME}（数据目录保留在 ${formatPath(DATA_DIR)}）`);
  } else {
    console.log(`[db-dev] 未能停止（可能本来就没在运行）：${(result.stderr ?? '').trim()}`);
  }
}

function status() {
  assertDockerAvailable();
  const result = docker([
    'ps',
    '-a',
    '--filter',
    `name=^${CONTAINER_NAME}$`,
    '--format',
    '{{.Status}}',
  ]);
  const line = (result.stdout ?? '').trim();
  console.log(line === '' ? `[db-dev] 容器 ${CONTAINER_NAME} 不存在` : `[db-dev] ${line}`);
  console.log(`[db-dev] 数据目录 ${formatPath(DATA_DIR)}`);
}

switch (process.argv[2]) {
  case 'up':
    await start();
    break;
  case 'down':
    stop();
    break;
  case 'status':
    status();
    break;
  default:
    console.error('用法：node scripts/env/db-dev.mjs <up|down|status>');
    process.exit(2);
}
