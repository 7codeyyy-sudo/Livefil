/**
 * FND-001 验收脚本。
 *
 * 把任务验收标准固化为可复现的自动检查，而不是一次性的人工验证：
 *   1. 合法环境变量下 `next build` 成功。
 *   2. 合法环境变量下 `next start` 可启动，首页返回 200 并渲染出产品名。
 *   3. 非法环境变量下 `next start` 启动失败，且错误信息指明具体变量。
 *   4. 非法环境变量下 `next build` 构建失败，且错误信息指明具体变量。
 *
 * 运行：npm run test:e2e
 *
 * 说明：本脚本刻意使用 Node 内置能力与项目既有工具（scripts/env/paths.mjs），
 * 不预先替 FND-003 选定 E2E 框架。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { PATHS, PROJECT_ROOT, formatPath } from '../../scripts/env/paths.mjs';

/** 非法取值，用于验证启动/构建阶段必须明确失败。 */
const INVALID_LOG_LEVEL = 'verbose';

/**
 * 「合法环境」的显式取值——每条需要合法环境的用例都以此为基础，不再裸继承宿主环境。
 *
 * ## 为什么必须显式给出
 *
 * 这些用例原先是 `env: { ...process.env }`，绿不绿取决于**跑的那台机器上有没有
 * 未入库的 `.env.local`**。实测把它移开后，构建 / `next start` / `next dev` 三条
 * 全部变红。验收脚本的价值恰恰是「在任何一台机器上给出同样的判定」，把结论建立在
 * 开发机的本地状态上，等于让门禁在最需要它的场景（新机器、CI）失效。
 *
 * Phase 2 起这一点变得必须：本地会话签名器要求 `AUTH_SECRET`（§8.3 装配期失败），
 * 缺它 `next start` 直接起不来——而这正是本脚本要断言「合法环境下服务可启动」的场景。
 *
 * ## 为什么 AUTH_SECRET 用运行时随机值而不是字面量
 *
 * 仓库是 Public，连「测试专用密钥」这类字面量都不该落盘；随机生成同时让本机与 CI
 * 走**完全同一条路径**（不依赖任何一侧额外注入），判定因此一致。签名器只要求长度
 * ≥ 32，64 个十六进制字符恒成立。
 */
const LEGAL_ENV = {
  LOG_LEVEL: 'info',
  AUTH_SECRET: randomBytes(32).toString('hex'),
};

/** 单次外部命令的最长等待时间，避免脚本在异常时无限挂起。 */
const COMMAND_TIMEOUT_MS = 180_000;

/** 服务就绪等待上限。 */
const READY_TIMEOUT_MS = 60_000;

const nextBin = path.join(PROJECT_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');

const nodeExecutable = (() => {
  const portable = path.join(
    PATHS.portableNode,
    process.platform === 'win32' ? 'node.exe' : 'bin/node',
  );
  return existsSync(portable) ? portable : process.execPath;
})();

/** 取一个当前空闲的端口，避免与开发中的服务（如 3000）冲突。 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('无法获取探测端口'));
        return;
      }
      const { port } = address;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * 运行一条一次性命令并收集输出。
 *
 * @returns {Promise<{ code: number | null, output: string }>} 退出码与合并输出。
 */
function runOnce(args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, [nextBin, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const collect = (chunk) => {
      output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令超时（${COMMAND_TIMEOUT_MS}ms）：next ${args.join(' ')}\n${output}`));
    }, COMMAND_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** 启动一个常驻服务进程，返回句柄与输出读取器。 */
function startServer(args, { env } = {}) {
  const child = spawn(nodeExecutable, [nextBin, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const collect = (chunk) => {
    output += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  return {
    child,
    readOutput: () => output,
    async stop() {
      if (child.exitCode !== null) {
        return;
      }
      // Windows 下 next 会派生子进程，必须终止整棵进程树，否则端口不会释放。
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
      await new Promise((resolve) => {
        child.once('close', resolve);
        setTimeout(resolve, 5_000);
      });
    },
  };
}

/** 轮询首页直到服务就绪，返回 HTTP 状态码与响应体。 */
async function waitForHomePage(port) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const url = `http://127.0.0.1:${port}/`;
  let lastError = '服务未在超时时间内就绪';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
    }
  }
  throw new Error(`等待首页超时：${lastError}`);
}

test('项目根目录与 Next 可执行文件已就绪', () => {
  assert.ok(existsSync(nextBin), `未找到 next 可执行文件：${formatPath(nextBin)}`);
  assert.ok(existsSync(PATHS.projectRoot), `未找到项目根目录：${formatPath(PATHS.projectRoot)}`);
});

test('合法环境变量下构建成功', async () => {
  const { code, output } = await runOnce(['build'], { env: LEGAL_ENV });

  assert.equal(code, 0, `构建应成功，实际退出码 ${code}\n${output}`);
});

test('合法环境变量下服务可启动且首页可用', async () => {
  const port = await findFreePort();
  const server = startServer(['start', '--port', String(port)], { env: LEGAL_ENV });
  try {
    const { status, body } = await waitForHomePage(port);

    assert.equal(status, 200, `首页应返回 200，实际 ${status}`);
    assert.match(body, /Livefil/, '首页应渲染产品名');
    // 断言启动期校验真的执行了：否则 instrumentation.ts 会变成死代码。
    assert.match(
      server.readOutput(),
      /服务端环境变量校验通过/,
      '启动时应执行 instrumentation.ts 中的服务端环境变量校验',
    );
  } finally {
    await server.stop();
  }
});

test('开发服务器可启动且首页可用', async () => {
  const port = await findFreePort();
  const server = startServer(['dev', '--port', String(port)], { env: LEGAL_ENV });
  try {
    const { status, body } = await waitForHomePage(port);

    assert.equal(status, 200, `首页应返回 200，实际 ${status}`);
    assert.match(body, /Livefil/, '首页应渲染产品名');
    assert.match(
      server.readOutput(),
      /服务端环境变量校验通过/,
      '开发模式启动时同样应执行服务端环境变量校验',
    );
  } finally {
    await server.stop();
  }
});

test('非法环境变量下服务启动失败且指明变量名', async () => {
  const port = await findFreePort();
  // 以「合法环境」为底再叠加非法取值：让失败**只**来自被断言的那一项。
  // 否则当宿主环境恰好缺 AUTH_SECRET 时，服务会先因别的原因挂掉，
  // 用例也许仍绿，但绿的原因不是它声称要验证的那个。
  const server = startServer(['start', '--port', String(port)], {
    env: { ...LEGAL_ENV, LOG_LEVEL: INVALID_LOG_LEVEL },
  });
  try {
    // 服务不应就绪；等待进程自行失败退出。
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('still-running'), READY_TIMEOUT_MS);
      server.child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.notEqual(exitCode, 'still-running', '非法环境变量下服务不应继续运行');
    assert.notEqual(exitCode, 0, '非法环境变量下服务应以非零退出码结束');
    assert.match(server.readOutput(), /LOG_LEVEL/, '错误信息应指明出错的变量名');
    assert.ok(!server.readOutput().includes(INVALID_LOG_LEVEL), '错误信息不应回显变量的非法取值');
  } finally {
    await server.stop();
  }
});

test('非法环境变量下构建失败且指明变量名', async () => {
  const { code, output } = await runOnce(['build'], {
    env: { ...LEGAL_ENV, LOG_LEVEL: INVALID_LOG_LEVEL },
  });

  assert.notEqual(code, 0, '非法环境变量下构建应以非零退出码结束');
  assert.match(output, /LOG_LEVEL/, '错误信息应指明出错的变量名');
  assert.ok(!output.includes(INVALID_LOG_LEVEL), '错误信息不应回显变量的非法取值');
});
