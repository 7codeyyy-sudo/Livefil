/**
 * 仓储用户作用域断言（IAM-004）。
 *
 * 与 `dependency-boundaries.test.ts` 同构：一边扫真实源码当守卫，一边把违规样本
 * 喂给检查器证明它**真的会失败**。只有前者的话，检查器退化成永远通过的摆设。
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectSourceFiles, type SourceFile } from './imports.ts';
import { extractWhereArguments } from './sql-arguments.ts';
import { findUnscopedQueries, formatUnscopedQueries } from './user-scope-rules.ts';

/** 由当前文件位置向上定位项目根。 */
function resolveProjectRoot(startDir: string): string {
  let current = startDir;

  for (;;) {
    if (existsSync(path.join(current, 'package.json'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`无法定位项目根目录：从 ${startDir} 向上未找到 package.json`);
    }
    current = parent;
  }
}

const PROJECT_ROOT_DIR = resolveProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 收集模块基础设施层里的仓储实现。
 *
 * 只扫 `*.drizzle.ts`（Drizzle 实现），而不是整个 `infrastructure/` 目录：
 * 本断言的对象是"拼 SQL 的那一层"，把不含查询的文件算进来只会稀释信噪比。
 */
function collectRepositoryImplementations(): readonly SourceFile[] {
  const modulesDir = path.join(PROJECT_ROOT_DIR, 'src', 'modules');
  if (!existsSync(modulesDir)) {
    return [];
  }

  const files: SourceFile[] = [];
  for (const moduleEntry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!moduleEntry.isDirectory()) {
      continue;
    }
    const infrastructureDir = path.join(modulesDir, moduleEntry.name, 'infrastructure');
    files.push(
      ...collectSourceFiles(infrastructureDir, PROJECT_ROOT_DIR).filter((file) =>
        file.relativePath.endsWith('.drizzle.ts'),
      ),
    );
  }
  return files;
}

function sourceFile(relativePath: string, content: string): SourceFile {
  return { relativePath, content };
}

describe('参数提取', () => {
  it('取出嵌套括号的完整条件文本', () => {
    const calls = extractWhereArguments(
      'db.select().from(t).where(and(eq(t.userId, userId), ne(t.id, x)));',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe('and(eq(t.userId, userId), ne(t.id, x))');
  });

  it('给出 1 起的行号', () => {
    const calls = extractWhereArguments('a\nb\n  .where(eq(t.userId, userId))\n');

    expect(calls[0]?.line).toBe(3);
  });

  it('一个文件里的多处调用全部取出', () => {
    const calls = extractWhereArguments('.where(a).where(b)');

    expect(calls.map((call) => call.text)).toEqual(['a', 'b']);
  });

  it('没有调用点时返回空数组', () => {
    expect(extractWhereArguments('const x = 1;')).toEqual([]);
  });
});

describe('当前仓储实现全部带用户作用域', () => {
  it('不存在越域查询', () => {
    const files = collectRepositoryImplementations();
    const report = findUnscopedQueries(files);

    // 前提校验：如果一条查询都没扫到，这条断言就变成了空转——
    // 上一轮 FND-004 的覆盖度检查正是这样漏掉了一整层目录。
    expect(report.whereCount, '应至少扫到仓储里的查询点').toBeGreaterThan(0);
    expect(report.violations, formatUnscopedQueries(report)).toEqual([]);
  });

  it('所有 where 都被判为带作用域或被显式豁免（数量守恒）', () => {
    const report = findUnscopedQueries(collectRepositoryImplementations());

    // 守恒式断言：不允许"既不算带作用域、也不算豁免"的第三类存在。
    // 没有这条，检查器将来漏判一个调用点也不会有人发现。
    expect(report.scopedCount + report.exemptCount).toBe(report.whereCount);
    expect(report.exemptCount).toBeGreaterThan(0);
  });
});

describe('豁免机制', () => {
  const header = '/**\n * 说明。\n * @user-scope-exempt: ';
  const footer = ' */\n';
  const query = 'db.select().from(t).where(eq(t.mode, LOCAL_MODE));';

  it('带理由的豁免标记不被报出', () => {
    const report = findUnscopedQueries([
      sourceFile(
        'src/modules/tasks/infrastructure/x.drizzle.ts',
        `${header}会话引导阶段读取唯一本地用户，此刻还没有 userId${footer}${query}`,
      ),
    ]);

    expect(report.violations).toEqual([]);
    expect(report.exemptCount).toBe(1);
  });

  it('理由太短的豁免标记**不生效**（豁免必须有成本）', () => {
    const report = findUnscopedQueries([
      sourceFile('src/modules/tasks/infrastructure/x.drizzle.ts', `${header}临时${footer}${query}`),
    ]);

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.reason).toContain('理由太短');
  });

  it('豁免只作用于它后面那一个调用点，不会顺延到下一个', () => {
    const content = [
      `${header}会话引导阶段读取唯一本地用户，此刻还没有 userId${footer}${query}`,
      'db.select().from(t).where(eq(t.id, id));',
    ].join('\n');

    const report = findUnscopedQueries([
      sourceFile('src/modules/tasks/infrastructure/x.drizzle.ts', content),
    ]);

    expect(report.exemptCount).toBe(1);
    expect(report.violations).toHaveLength(1);
  });
});

describe('越域查询会被检出（自证）', () => {
  it('where 里没有 userId 时被报出', () => {
    const report = findUnscopedQueries([
      sourceFile(
        'src/modules/tasks/infrastructure/x.drizzle.ts',
        'db.select().from(t).where(eq(t.id, id));',
      ),
    ]);

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.reason).toContain('userId');
  });

  it('完全没有 where 的查询点被报出', () => {
    const report = findUnscopedQueries([
      sourceFile('src/modules/tasks/infrastructure/x.drizzle.ts', 'await db.select().from(tasks);'),
    ]);

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.reason).toContain('没有 where');
  });

  it('带作用域的写法不会被误报', () => {
    const report = findUnscopedQueries([
      sourceFile(
        'src/modules/tasks/infrastructure/x.drizzle.ts',
        'await db.select().from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.id, id)));',
      ),
    ]);

    expect(report.violations).toEqual([]);
    expect(report.whereCount).toBe(1);
  });

  it('插入语句不会被误报（它不需要 where）', () => {
    const report = findUnscopedQueries([
      sourceFile(
        'src/modules/tasks/infrastructure/x.drizzle.ts',
        'await tx.insert(tasks).values({ userId, name });',
      ),
    ]);

    expect(report.violations).toEqual([]);
  });

  it('没有源文件时不报错', () => {
    expect(findUnscopedQueries([]).violations).toEqual([]);
  });
});
