/**
 * Phase 5 spike 结论静态验证（测试点 18）。
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(ROOT, '../../..');

describe('Phase 5 spike 结论静态验证', () => {
  it('零新依赖：锁文件未出现未预期依赖', () => {
    const lock = readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8');
    const forbidden = ['idb', 'dexie', 'dexie-react-hooks', 'workbox', 'react-query', 'swr'];
    for (const pkg of forbidden) {
      assert.ok(!lock.includes(`"${pkg}"`), `package-lock.json 出现未预期依赖 ${pkg}`);
    }
  });

  it('pending_operations 命名消歧：src/ 无混淆命名', () => {
    const hasForbiddenName =
      existsSync(path.join(projectRoot, 'src/modules/sync/infrastructure/outbox.ts')) ||
      existsSync(path.join(projectRoot, 'src/modules/sync/infrastructure/outbox-operation.ts'));
    assert.ok(!hasForbiddenName, 'src/modules/sync/infrastructure/ 下出现 outbox 相关文件');
  });

  it('零 serviceWorker 引用', () => {
    const dirs = ['src', 'app'];
    const matches: string[] = [];
    for (const base of dirs) {
      const basePath = path.join(projectRoot, base);
      if (!existsSync(basePath)) continue;
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
            const content = readFileSync(full, 'utf8');
            if (content.includes('serviceWorker') || content.includes('navigator.serviceWorker')) {
              matches.push(path.relative(projectRoot, full));
            }
          }
        }
      };
      walk(basePath);
    }
    assert.deepStrictEqual(matches, []);
  });
});
