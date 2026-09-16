/**
 * 分层依赖边界测试（FND-004）。
 *
 * 这个文件是「架构约束」的可执行形式。它同时承担两类职责：
 *   1. **守卫**：扫描真实源码，任何越界引用都会让构建失败。
 *   2. **自证**：把违规样本喂给规则，证明检查器**确实会失败**。
 *      只有第 1 条而没有第 2 条，规则退化成一个永远通过的摆设。
 *
 * 边界覆盖刻意包含「合规不应误报」——误报会迫使开发者给检查器加例外，
 * 而例外一旦堆积，约束就名存实亡。
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEPENDENCY_RULES,
  findViolations,
  formatViolations,
  matchesDirectoryPattern,
  toPackageName,
} from './dependency-rules.ts';
import {
  collectSourceFiles,
  extractImportSpecifiers,
  normalizeSpecifier,
  stripComments,
  type SourceFile,
} from './imports.ts';

/**
 * 由当前文件位置向上定位项目根。
 *
 * 不依赖 `process.cwd()`：从子目录或编辑器内单跑某个文件时仍需可用。
 */
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

/** 构造一个源文件条目。 */
function sourceFile(relativePath: string, content: string): SourceFile {
  return { relativePath, content };
}

/**
 * 列出目录下的子目录名。
 *
 * @param absoluteDir 绝对路径。
 * @returns 子目录名（已排序）；目录不存在时返回空数组。
 */
function listSubdirectories(absoluteDir: string): readonly string[] {
  if (!existsSync(absoluteDir)) {
    return [];
  }

  return readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * 从**实际目录结构**推导全部应受依赖规则约束的目录。
 *
 * 刻意不维护手写清单：上一版就是用手写的样本目录做覆盖度检查，
 * 而清单本身漏掉了 `src/modules/<模块>/infrastructure`（13 个目录），
 * 致使那一层完全没有约束——手写清单的覆盖度检查无法证明自己没漏。
 * 从文件系统推导后，新增模块或新增层会自动纳入检查范围。
 *
 * @returns 受约束目录的相对路径列表。
 */
function collectConstrainedDirectories(): readonly string[] {
  const directories = ['app', 'src/infrastructure', 'src/shared'];
  const modulesDir = path.join(PROJECT_ROOT_DIR, 'src', 'modules');

  for (const moduleName of listSubdirectories(modulesDir)) {
    for (const layer of listSubdirectories(path.join(modulesDir, moduleName))) {
      directories.push(`src/modules/${moduleName}/${layer}`);
    }
  }

  return directories;
}

describe('当前仓库的依赖方向', () => {
  it('src 下的源码不违反任何分层依赖规则', () => {
    const files = collectSourceFiles(path.join(PROJECT_ROOT_DIR, 'src'), PROJECT_ROOT_DIR);
    const violations = findViolations(files);

    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('app 下的源码不违反任何分层依赖规则', () => {
    const files = collectSourceFiles(path.join(PROJECT_ROOT_DIR, 'app'), PROJECT_ROOT_DIR);
    const violations = findViolations(files);

    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

describe('越界引用会被检出', () => {
  it('领域层引用 next/server', () => {
    const violations = findViolations([
      sourceFile('src/modules/tasks/domain/task.ts', "import { NextResponse } from 'next/server';"),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toContain('领域层');
  });

  it('领域层引用 react', () => {
    const violations = findViolations([
      sourceFile('src/modules/tasks/domain/task.ts', "import { useState } from 'react';"),
    ]);

    expect(violations).toHaveLength(1);
  });

  it('领域层通过相对路径引用基础设施', () => {
    const violations = findViolations([
      sourceFile(
        'src/modules/tasks/domain/task.ts',
        "import { taskRepository } from '../infrastructure/task-repository.ts';",
      ),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.resolved).toBe('src/modules/tasks/infrastructure/task-repository.ts');
  });

  it('应用层引用基础设施', () => {
    const violations = findViolations([
      sourceFile(
        'src/modules/tasks/application/create-task.ts',
        "import { db } from '@/infrastructure/database/client.ts';",
      ),
    ]);

    expect(violations).toHaveLength(1);
  });

  it('表现层直接引用领域层', () => {
    const violations = findViolations([
      sourceFile(
        'src/modules/tasks/presentation/task-card.tsx',
        "import { TaskStatus } from '@/modules/tasks/domain/task-status.ts';",
      ),
    ]);

    expect(violations).toHaveLength(1);
  });

  it('App Router 直接引用基础设施', () => {
    const violations = findViolations([
      sourceFile(
        'app/api/v1/tasks/route.ts',
        "import { db } from '@/infrastructure/database/client.ts';",
      ),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toContain('App Router');
  });

  it('基础设施反向依赖应用层', () => {
    const violations = findViolations([
      sourceFile(
        'src/infrastructure/database/task-repository.ts',
        "import { createTask } from '@/modules/tasks/application/create-task.ts';",
      ),
    ]);

    expect(violations).toHaveLength(1);
  });

  it('模块内基础设施反向依赖应用层', () => {
    const violations = findViolations([
      sourceFile(
        'src/modules/tasks/infrastructure/task-repository.ts',
        "import { createTask } from '@/modules/tasks/application/create-task.ts';",
      ),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toContain('模块内基础设施');
  });

  it('模块内基础设施引用框架包', () => {
    const violations = findViolations([
      sourceFile(
        'src/modules/tasks/infrastructure/task-repository.ts',
        "import { useState } from 'react';",
      ),
    ]);

    expect(violations).toHaveLength(1);
  });

  it('模块内基础设施引用表现层与 App Router', () => {
    const violations = findViolations([
      sourceFile(
        'src/modules/tasks/infrastructure/task-repository.ts',
        [
          "import { TaskCard } from '@/modules/tasks/presentation/task-card.tsx';",
          "import { homePage } from '../../../../app/page.tsx';",
        ].join('\n'),
      ),
    ]);

    expect(violations).toHaveLength(2);
  });

  it('共享层依赖业务模块', () => {
    const violations = findViolations([
      sourceFile(
        'src/shared/money/amount.ts',
        "import { Task } from '@/modules/tasks/domain/task.ts';",
      ),
    ]);

    expect(violations).toHaveLength(1);
  });

  it('一个文件的多条越界引用全部会被报告', () => {
    const violations = findViolations([
      sourceFile(
        'src/modules/tasks/domain/task.ts',
        [
          "import { NextResponse } from 'next/server';",
          "import { db } from '@/infrastructure/database/client.ts';",
        ].join('\n'),
      ),
    ]);

    expect(violations).toHaveLength(2);
  });
});

describe('合规引用不会被误报', () => {
  it('领域层内部的相对引用', () => {
    expect(
      findViolations([
        sourceFile(
          'src/modules/tasks/domain/task.ts',
          "import { TaskStatus } from './task-status.ts';",
        ),
      ]),
    ).toEqual([]);
  });

  it('应用层引用本模块的领域层', () => {
    expect(
      findViolations([
        sourceFile(
          'src/modules/tasks/application/create-task.ts',
          "import { Task } from '../domain/task.ts';",
        ),
      ]),
    ).toEqual([]);
  });

  it('应用层跨模块引用其他模块的领域层与应用层', () => {
    expect(
      findViolations([
        sourceFile(
          'src/modules/execution/application/record-execution.ts',
          [
            "import { Task } from '@/modules/tasks/domain/task.ts';",
            "import { createTask } from '@/modules/tasks/application/create-task.ts';",
          ].join('\n'),
        ),
      ]),
    ).toEqual([]);
  });

  it('基础设施引用领域层以实现在端口', () => {
    expect(
      findViolations([
        sourceFile(
          'src/infrastructure/database/task-repository.ts',
          "import { TaskRepository } from '@/modules/tasks/domain/task-repository.ts';",
        ),
      ]),
    ).toEqual([]);
  });

  it('模块内基础设施引用领域层、共享层与顶层基础设施', () => {
    // 这正是仓储实现的标准形态：实现本模块领域端口、复用共享工具与全局数据库客户端。
    // 若这条被误报，说明新规则的范围过宽。
    expect(
      findViolations([
        sourceFile(
          'src/modules/tasks/infrastructure/task-repository.ts',
          [
            "import { TaskRepository } from '../domain/task-repository.ts';",
            "import { formatAmount } from '@/shared/money/format.ts';",
            "import { db } from '@/infrastructure/database/client.ts';",
          ].join('\n'),
        ),
      ]),
    ).toEqual([]);
  });

  it('App Router 引用应用层与共享层', () => {
    expect(
      findViolations([
        sourceFile(
          'app/api/v1/tasks/route.ts',
          [
            "import { createTask } from '@/modules/tasks/application/create-task.ts';",
            "import { parseServerEnv } from '@/shared/validation/env.server.ts';",
          ].join('\n'),
        ),
      ]),
    ).toEqual([]);
  });
});

describe('说明符解析', () => {
  it('@/ 别名解析为 src 下的路径', () => {
    expect(normalizeSpecifier('@/modules/tasks/domain/task.ts', 'app/page.tsx')).toBe(
      'src/modules/tasks/domain/task.ts',
    );
  });

  it('相对路径按引用方所在目录解析', () => {
    expect(
      normalizeSpecifier('../domain/task.ts', 'src/modules/tasks/application/create-task.ts'),
    ).toBe('src/modules/tasks/domain/task.ts');
  });

  it('外部包名原样保留', () => {
    expect(normalizeSpecifier('next/server', 'app/page.tsx')).toBe('next/server');
    expect(normalizeSpecifier('node:fs', 'app/page.tsx')).toBe('node:fs');
  });

  it('包名提取覆盖 scoped 包与子路径', () => {
    expect(toPackageName('next/server')).toBe('next');
    expect(toPackageName('react-dom/client')).toBe('react-dom');
    expect(toPackageName('@testing-library/react')).toBe('@testing-library/react');
    expect(toPackageName('@testing-library/react/pure')).toBe('@testing-library/react');
    expect(toPackageName('zod')).toBe('zod');
  });
});

describe('注释处理', () => {
  it('注释中的示例导入不计入依赖', () => {
    const source = [
      '// 领域层不得 import next/server',
      "/* import { NextResponse } from 'next/server'; */",
      "import { ok } from './ok.ts';",
    ].join('\n');

    expect(extractImportSpecifiers(source)).toEqual(['./ok.ts']);
  });

  it('URL 中的双斜杠不会被当作注释起点', () => {
    const source = ["const docs = 'https://example.com/spec';", "import { a } from './a.ts';"].join(
      '\n',
    );

    expect(stripComments(source)).toContain('https://example.com/spec');
    expect(extractImportSpecifiers(source)).toEqual(['./a.ts']);
  });
});

describe('导入形态覆盖', () => {
  it('静态导入、副作用导入、re-export、动态导入与 require 都能提取', () => {
    const source = [
      "import a from 'pkg-a';",
      "import 'pkg-b';",
      "export { c } from 'pkg-c';",
      "const d = await import('pkg-d');",
      "const e = require('pkg-e');",
    ].join('\n');

    expect(extractImportSpecifiers(source)).toEqual(['pkg-a', 'pkg-b', 'pkg-c', 'pkg-d', 'pkg-e']);
  });
});

describe('目录模式匹配', () => {
  it('同时匹配目录自身与其中的文件', () => {
    expect(matchesDirectoryPattern('src/shared', 'src/shared')).toBe(true);
    expect(matchesDirectoryPattern('src/shared/money/amount.ts', 'src/shared')).toBe(true);
  });

  it('星号只匹配单个路径段', () => {
    expect(
      matchesDirectoryPattern('src/modules/tasks/domain/task.ts', 'src/modules/*/domain'),
    ).toBe(true);
    expect(matchesDirectoryPattern('src/modules/a/b/domain/task.ts', 'src/modules/*/domain')).toBe(
      false,
    );
  });

  it('不匹配同前缀的兄弟目录', () => {
    expect(matchesDirectoryPattern('src/shared-utils/a.ts', 'src/shared')).toBe(false);
    expect(
      matchesDirectoryPattern('src/modules/tasks/domainx/a.ts', 'src/modules/tasks/domain'),
    ).toBe(false);
  });
});

describe('规则表覆盖度', () => {
  it('每一个实际的层目录都有对应规则（从目录结构推导，不用手写清单）', () => {
    const constrainedDirectories = collectConstrainedDirectories();

    // 前提校验：推导结果必须真的包含模块内基础设施层。
    // 没有这一步，这条用例可能在「什么都没检查到」的情况下通过——
    // 上一版正是因为样本清单漏了这一层，才让 13 个目录完全失去约束。
    expect(constrainedDirectories).toContain('src/modules/tasks/infrastructure');
    expect(constrainedDirectories.length).toBeGreaterThan(50);

    const uncovered = constrainedDirectories.filter(
      (directory) =>
        !DEPENDENCY_RULES.some((rule) => matchesDirectoryPattern(directory, rule.appliesTo)),
    );

    expect(uncovered, `以下目录没有对应的依赖规则：${uncovered.join(', ')}`).toEqual([]);
  });
});

describe('空数据', () => {
  it('没有源文件时不报错且无违规', () => {
    expect(findViolations([])).toEqual([]);
  });

  it('目录不存在时返回空列表而不是抛错', () => {
    expect(
      collectSourceFiles(path.join(PROJECT_ROOT_DIR, 'src', '__not_created__'), PROJECT_ROOT_DIR),
    ).toEqual([]);
  });
});
