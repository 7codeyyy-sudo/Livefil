#!/usr/bin/env node
/**
 * 把 `package-lock.json` 的 `resolved` 主机统一为官方源（FND-006）。
 *
 * 为什么需要它：锁文件的 `resolved` 会继承**安装时**生效的 registry。
 * 本机全局配置指向第三方镜像时，镜像主机就被固化进了锁文件，而 CI 无法得知这件事。
 *
 * 为什么不重新生成锁文件：`npm install --package-lock-only --registry=<官方源>`
 * 对已是最新的锁文件是空操作（报 “up to date” 直接退出），`--registry` 不会重写
 * 已有条目；删档重生成则会重新求解依赖树——实测会改动 6 个包的版本与 6 处 integrity，
 * 远超「只换主机」的范围。因此这里只做**确定性的主机替换**，其余字节原样保留。
 *
 * 顺带也解释了 npm 的 `replace-registry-host`（默认 `npmjs`）为何救不了这个局面：
 * 它只在**读取**时把指向默认源的地址换成当前配置的 registry，不会改写文件；
 * 而镜像主机不是默认源，任何方向都不会被替换。
 *
 * 用法：
 *   node scripts/ci/normalize-lockfile-registry.mjs          改写为官方源
 *   node scripts/ci/normalize-lockfile-registry.mjs --check  只校验，非官方源即失败
 *
 * 本文件不含任何本机绝对路径。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT, formatPath } from '../env/paths.mjs';

/** 官方源主机名。锁文件里出现的 registry 地址最终都应是它。 */
const OFFICIAL_HOST = 'registry.npmjs.org';

/**
 * 会被改写的第三方镜像主机。
 *
 * 刻意用白名单而非「凡非官方源皆改写」：将来若引入 git 或 file 依赖，
 * 那些 `resolved` 也是合法地址，不该被误改成 registry 路径。
 */
const MIRROR_HOSTS = Object.freeze(['registry.npmmirror.com', 'registry.npm.taobao.org']);

const LOCKFILE = path.join(PROJECT_ROOT, 'package-lock.json');

/** 匹配一条 `"resolved": "<url>"`，只取绝对 URL。 */
const RESOLVED_PATTERN = /"resolved"\s*:\s*"(https?:\/\/[^"]+)"/g;

const checkOnly = process.argv.includes('--check');

/**
 * 取出锁文件中全部 `resolved` 的绝对 URL。
 *
 * @param {string} text 锁文件原文。
 * @returns {string[]} URL 列表。
 */
function collectResolvedUrls(text) {
  return [...text.matchAll(RESOLVED_PATTERN)].map((match) => match[1]);
}

/**
 * 取 URL 的主机名；无法解析时返回空串。
 *
 * @param {string} url 绝对 URL。
 * @returns {string} 主机名。
 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

const original = readFileSync(LOCKFILE, 'utf8');
const urls = collectResolvedUrls(original);

if (checkOnly) {
  const offenders = urls.filter((url) => hostOf(url) !== OFFICIAL_HOST);
  if (offenders.length === 0) {
    console.log(
      `锁文件 resolved 主机检查通过：${urls.length} 条全部指向 ${OFFICIAL_HOST}（${formatPath(LOCKFILE)}）。`,
    );
    process.exit(0);
  }

  const byHost = new Map();
  for (const url of offenders) {
    const host = hostOf(url) || '(无法解析)';
    byHost.set(host, (byHost.get(host) ?? 0) + 1);
  }
  console.error(
    `锁文件 resolved 主机检查失败：${offenders.length} / ${urls.length} 条不是官方源。`,
  );
  for (const [host, count] of [...byHost].sort()) {
    console.error(`  ${host}: ${count} 条`);
  }
  console.error('请执行：node scripts/ci/normalize-lockfile-registry.mjs');
  process.exit(1);
}

let updated = original;
const replacedByHost = new Map();

for (const host of MIRROR_HOSTS) {
  const from = `https://${host}/`;
  const to = `https://${OFFICIAL_HOST}/`;
  const segments = updated.split(from);
  const count = segments.length - 1;
  if (count === 0) {
    continue;
  }
  replacedByHost.set(host, count);
  updated = segments.join(to);
}

if (updated === original) {
  console.log(`锁文件无需改写：${urls.length} 条 resolved 均不指向已登记的镜像。`);
  process.exit(0);
}

writeFileSync(LOCKFILE, updated, 'utf8');

console.log(`锁文件已改写：${formatPath(LOCKFILE)}`);
for (const [host, count] of [...replacedByHost].sort()) {
  console.log(`  ${host} → ${OFFICIAL_HOST}：${count} 条`);
}
console.log('仅主机名发生变化；路径、版本与 integrity 均未改动。');
