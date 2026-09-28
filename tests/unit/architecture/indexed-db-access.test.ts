/**
 * Block indexedDB access from app/** and src/shared/ui/** (test point 1).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(ROOT, '../../..');

const ALLOWED_INDEXED_DB_FILES = new Set([
  'src/modules/sync/infrastructure/local-store.indexeddb.ts',
  'src/modules/sync/domain/local-store.ts',
]);

const FORBIDDEN_PATTERNS = [
  /\bindexedDB\b/,
  /\bIDBDatabase\b/,
  /\bIDBKeyRange\b/,
  /\bIDBTransaction\b/,
  /\bIDBObjectStore\b/,
  /\bIDBRequest\b/,
  /\bIDBValidKey\b/,
  /\bIDBFactory\b/,
];

describe('indexedDB access architecture assertion', () => {
  it('ESLint config contains INDEXED_DB_ACCESS_RULES', () => {
    const eslintConfig = readFileSync(path.join(projectRoot, 'eslint.config.mjs'), 'utf8');
    expect(eslintConfig).toContain('INDEXED_DB_ACCESS_RULES');
    expect(eslintConfig).toContain('local-store.indexeddb.ts');
  });

  it('no indexedDB references under src/ or app/', () => {
    const violations: string[] = [];

    for (const baseDir of ['src', 'app']) {
      const basePath = path.join(projectRoot, baseDir);
      if (!existsSync(basePath)) continue;

      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
            const relative = path.relative(projectRoot, full).replace(/\\/g, '/');
            if (ALLOWED_INDEXED_DB_FILES.has(relative)) continue;

            let content = readFileSync(full, 'utf8');
            content = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
            for (const pattern of FORBIDDEN_PATTERNS) {
              if (pattern.test(content)) {
                violations.push(relative);
                break;
              }
            }
          }
        }
      };

      walk(basePath);
    }

    expect(violations, `indexedDB violations: ${violations.join(', ')}`).toEqual([]);
  });
});
