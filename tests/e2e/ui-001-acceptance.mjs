/**
 * UI-001「建立设计令牌」验收脚本。
 *
 * 与既有 fnd-00x 验收脚本保持同一形态：自包含、`node:test`、可单独执行，
 * 通过 `test:e2e` 的 glob 自动纳入。
 *
 * 本脚本负责的是**纪律类断言**——那些「文件写对了但约束没成立」的失效模式：
 * 令牌是否真的只有一个来源、颜色是否真的没有第二处书写点、
 * 深色是否真的没被悄悄激活。取值与规范的一致性由
 * `tests/unit/shared/ui/tokens.test.ts` 负责，令牌是否真的生效由
 * `tests/e2e/tokens.spec.ts` 负责。
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { PROJECT_ROOT, formatPath } from '../../scripts/env/paths.mjs';

/** 令牌文件：全站视觉取值的唯一来源。 */
const TOKENS_FILE = path.join(PROJECT_ROOT, 'src', 'shared', 'ui', 'styles', 'tokens.css');

/** 根布局：令牌的唯一导入点。 */
const ROOT_LAYOUT_FILE = path.join(PROJECT_ROOT, 'app', 'layout.tsx');

/**
 * 参与纪律扫描的应用源码目录与扩展名。
 *
 * **刻意不含 `tests/`**：测试夹具合理地需要期望值与字面量（例如
 * `tests/e2e/tokens.spec.ts` 里就有响应式断点的期望像素值），
 * 它们不构成生产侧的取值来源，扫进来只会持续产生需要豁免的噪音。
 * 这与 `env:check` 的扫描面不收 `tests/` 是同一条口径。
 *
 * 反过来说：本文件下面那条「断点像素值不得出现在 TS/TSX 中」的断言
 * 只约束 `app/` 与 `src/`——组件 CSS 的媒体查询、以及测试里的期望值
 * 都不算「第二份断点取值」。
 */
const SCANNED_DIRECTORIES = ['app', 'src'];
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.css'];

/** 颜色字面量的三种写法。 */
const COLOR_LITERAL_PATTERN = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/;

/** 《UI 页面规范》§3.1 的断点像素值。 */
const BREAKPOINT_PIXEL_PATTERN = /\b(320|767|768|1023|1024|1439|1440)\b/;

/**
 * 令牌文件允许出现的自定义属性前缀（UI-002 批次 1 扩充）。
 *
 * 这是一份**白名单**：令牌文件里出现任何不在此列的自定义属性都该被质疑——
 * 否则「设计令牌」会慢慢退化成一个谁都能往里丢变量的杂物箱。
 *
 * `--line-height-` 单列的原因：§2.4 把行高归在 `--font-*` 族里，而实现把
 * 「字体族 / 字号 / 字重 / 行高」拆成四个可独立演进的前缀——写成
 * `--font-line-height-body` 读起来像「字体的行高」而不是「行高」，更容易误读。
 * 这是对族清单的一处**细化**，不是新增一族。
 */
const ALLOWED_TOKEN_PREFIXES = [
  '--color-',
  '--shadow-',
  '--font-',
  '--line-height-',
  '--space-',
  '--layout-',
  '--radius-',
  '--duration-',
  '--ease-',
  '--size-',
  '--z-',
];

/**
 * 当前阶段**必须存在**的令牌族。
 *
 * `--z-` 从 UI-002 批次 3a 起进入必存清单：层级令牌随 Modal/ConfirmDialog 落了
 * 前两枚（`--z-scrim`、`--z-overlay`），批次 3b 的 Toast 补上第三枚 `--z-toast`，
 * 至此「遮罩 → 面板 → 全局提示」三档齐全。
 */
const REQUIRED_TOKEN_FAMILIES = [
  '--color-',
  '--shadow-',
  '--font-',
  '--space-',
  '--radius-',
  '--duration-',
  '--ease-',
  '--size-',
  '--z-',
];

/**
 * 时长字面量（`150ms`、`0.2s`、`1s`），只应出现在令牌文件里。
 *
 * `m?s` 同时覆盖 `ms` 与 `s` 两种单位：规范 §2.4 的使用规则禁的是「`ms`/`s` 时长
 * 字面量」，只拦 `ms` 会漏掉 `transition: 0.2s` 这种同样常见的写法。
 */
const DURATION_LITERAL_PATTERN = /\d+(?:\.\d+)?m?s\b/;

/** 数字 z-index，只应通过 `--z-*` 令牌表达。 */
const NUMERIC_Z_INDEX_PATTERN = /z-index\s*:\s*-?\d+/;

/**
 * 带单位的数字圆角，只应通过 `--radius-*` 令牌表达（UI-002 批次 2 新增）。
 *
 * 放行三类合法写法：`var(...)`（引用令牌）、`50%`（头像与时间线圆点的几何写法，
 * 不是半径档位）、无单位 `0`。同一条纪律在 JSX 内联样式里的 camelCase 形态
 * 一并覆盖——否则「组件里写死圆角」只是换了个写法就绕过去了。
 *
 * 局限：逐行匹配，值跨行书写（超长时 Prettier 会换行）不在覆盖范围内。
 * 这是与其它扫描一致的取舍——用整文件正则会让「第几行出错」无法报告。
 */
const NUMERIC_RADIUS_PATTERN = /(?:border-radius|borderRadius)\s*:\s*[^;,}]*\b\d+(?:\.\d+)?px/;

/**
 * 数字字号，只应通过 `--font-size-*` 令牌表达（UI-002 批次 2 新增）。
 *
 * 有了这条，原型 `.tag` 的 11px 这类「档位外的孤立取值」就不能悄悄回到代码里。
 * 注意 `--font-size-body: 16px` 这种**令牌声明**不会命中：`font-size` 之后
 * 紧跟的是 `-` 而不是 `:`。
 */
const NUMERIC_FONT_SIZE_PATTERN = /(?:font-size|fontSize)\s*:\s*[^;,}]*\d+(?:\.\d+)?(?:px|rem|em)/;

/** 读取项目内文件。 */
function readProjectFile(file) {
  return readFileSync(file, 'utf8');
}

/** 递归收集目录下指定扩展名的文件。 */
function collectFiles(directory, extensions) {
  if (!existsSync(directory)) {
    return [];
  }
  const collected = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectFiles(entryPath, extensions));
      continue;
    }
    if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
      collected.push(entryPath);
    }
  }
  return collected;
}

/** 应用源码文件（`app/**` 与 `src/**` 下的 ts/tsx/css）。 */
function collectApplicationFiles() {
  return SCANNED_DIRECTORIES.flatMap((directory) =>
    collectFiles(path.join(PROJECT_ROOT, directory), SCANNED_EXTENSIONS),
  );
}

/** 找出内容匹配给定模式的文件，返回可读的相对路径与首次命中行。 */
function findMatches(files, pattern) {
  const matches = [];
  for (const file of files) {
    const lines = readProjectFile(file).split(/\r?\n/);
    const lineIndex = lines.findIndex((line) => pattern.test(line));
    if (lineIndex !== -1) {
      matches.push({
        file: formatPath(file),
        line: lineIndex + 1,
        content: (lines[lineIndex] ?? '').trim(),
      });
    }
  }
  return matches;
}

/** 判断给定文件是否为令牌文件本身。 */
function isTokensFile(file) {
  return path.resolve(file) === path.resolve(TOKENS_FILE);
}

test('令牌文件存在，且定义了 §2.4 要求的全部令牌族', () => {
  assert.ok(existsSync(TOKENS_FILE), `缺少令牌文件：${formatPath(TOKENS_FILE)}`);

  const source = readProjectFile(TOKENS_FILE);

  // 判定必须落在**真实的声明**（`--x:` 形式）上，不能用文本包含：
  // 注释里提到一个"尚未落地"的令牌名（例如 `--z-toast` 要等批次 3b）是正常的
  // 说明方式，而 `includes` 会被注释喂饱——把真定义删掉也不会变红。
  const declared = [...source.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]);

  // 只断言"族"存在，逐个取值由单元测试负责——验收脚本不该复制另一份取值表，
  // 两份清单必然漂移。
  for (const family of REQUIRED_TOKEN_FAMILIES) {
    assert.ok(
      declared.some((name) => name !== undefined && name.startsWith(family)),
      `令牌文件应定义 ${family} 族的令牌（要在声明里出现，注释中提及不算）`,
    );
  }

  // 白名单：令牌文件里不应出现计划外的自定义属性。
  const unexpected = declared.filter(
    (name) =>
      name !== undefined && !ALLOWED_TOKEN_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );

  assert.deepEqual(
    unexpected,
    [],
    `令牌文件出现了计划外的自定义属性（确需新增时先扩 ALLOWED_TOKEN_PREFIXES 并说明来源）：\n${unexpected.join('\n')}`,
  );

  assert.match(source, /:root\s*\{/, '令牌应定义在 :root 上');
  assert.match(source, /color-scheme:\s*light/, '第一阶段必须声明 color-scheme: light');
});

test('令牌由根布局唯一导入，全仓没有第二个导入点', () => {
  const layoutSource = readProjectFile(ROOT_LAYOUT_FILE);

  assert.match(
    layoutSource,
    /import\s+'@\/shared\/ui\/styles\/tokens\.css'/,
    '根布局必须以 `@/shared/ui/styles/tokens.css` 导入令牌',
  );

  // 只认**导入语句**，不认文本提及。
  //
  // 早先这里写的是 `/tokens\.css/`，于是任何在注释或文档里提到这个文件名的
  // 源码都被当成"第二个导入点"——那会逼出一条反常识的约束：不许在注释里
  // 提文件名。检查器的匹配过宽会把正常的表达方式一并禁掉。
  //
  // `m` flag 是必需的：这里 test 的是**整个文件内容**，没有 `m` 时 `^`
  // 只匹配字符串开头，于是除文件第一行之外的 import 全被漏掉——
  // 断言会退化成「谁都匹配不上」。
  const importPattern = /^\s*import\b.*tokens\.css/m;
  const importers = collectApplicationFiles().filter(
    (file) => !isTokensFile(file) && importPattern.test(readProjectFile(file)),
  );

  assert.deepEqual(
    importers.map((file) => formatPath(file)),
    [formatPath(ROOT_LAYOUT_FILE)],
    '令牌文件应只有一个导入点；多个导入点会产生重复的全局样式',
  );
});

test('令牌文件之外不存在颜色字面量（纪律：语义色只有一个来源）', () => {
  const sourceFiles = collectApplicationFiles().filter((file) => !isTokensFile(file));
  const offenders = findMatches(sourceFiles, COLOR_LITERAL_PATTERN);

  assert.deepEqual(
    offenders,
    [],
    `颜色必须来自令牌，不得在别处书写字面量：\n${offenders
      .map((item) => `  ${item.file}:${String(item.line)} ${item.content}`)
      .join('\n')}`,
  );
});

test('深色未被激活：没有 data-theme 设置点', () => {
  // 令牌文件里的 `html[data-theme='dark']` 是**选择器定义**，允许存在；
  // 这里查的是别处有没有人去**设置**这个属性。
  const sourceFiles = collectApplicationFiles().filter((file) => !isTokensFile(file));
  const offenders = findMatches(sourceFiles, /data-theme/);

  assert.deepEqual(
    offenders,
    [],
    `深色只预留不激活，不得设置 data-theme：\n${offenders
      .map((item) => `  ${item.file}:${String(item.line)} ${item.content}`)
      .join('\n')}`,
  );
});

test('深色未被激活：没有 prefers-color-scheme', () => {
  // 用媒体查询实现深色会让系统深色用户直接看到**未验收**的样式，
  // 等于绕过开关交付。这不只是风格问题。
  const offenders = collectApplicationFiles()
    .filter((file) => !isTokensFile(file))
    .filter((file) => /prefers-color-scheme/.test(readProjectFile(file)))
    .map((file) => formatPath(file));

  assert.deepEqual(offenders, [], `不得使用 prefers-color-scheme：\n${offenders.join('\n')}`);
});

test('深色占位块存在，但块内不声明任何颜色（值留空）', () => {
  const source = readProjectFile(TOKENS_FILE);
  const darkBlock = /html\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(source)?.[1];

  assert.ok(darkBlock !== undefined, '应保留深色占位块，供将来激活时使用');
  assert.ok(
    !darkBlock.includes('--color-'),
    '深色块内的颜色值必须留空：填入猜测值会在将来被误认为已验收的设计',
  );
});

test('断点未做成 CSS 变量，且 JS 侧没有第二份断点取值', () => {
  const tokensSource = readProjectFile(TOKENS_FILE);

  assert.ok(
    !/--[a-z-]*(breakpoint|screen)[a-z-]*\s*:/.test(tokensSource),
    'CSS 变量无法用于 @media 条件，断点不得做成变量',
  );

  // 组件 CSS 里的媒体查询写像素值是允许的（那是 CSS 表达响应式的唯一方式）；
  // 受限的是 **TS/JS 侧**——断点像素值只允许出现在唯一的镜像文件里，
  // 而目前还没有镜像文件，因此应当零命中。
  const scriptFiles = collectApplicationFiles().filter(
    (file) => file.endsWith('.ts') || file.endsWith('.tsx'),
  );
  const offenders = findMatches(scriptFiles, BREAKPOINT_PIXEL_PATTERN);

  assert.deepEqual(
    offenders,
    [],
    `断点像素值不得出现在 TS/TSX 中（JS 需要时须建立唯一镜像文件）：\n${offenders
      .map((item) => `  ${item.file}:${String(item.line)} ${item.content}`)
      .join('\n')}`,
  );
});

test('令牌文件之外不出现时长字面量（动效必须走 --duration-*）', () => {
  // 时长散写是「颜色字面量」问题的翻版，而且更隐蔽：没有任何视觉检查能发现
  // 「两个浮层的动画快慢不同」。有了这条扫描，动效令牌才不只是愿望。
  const styleSheets = collectApplicationFiles()
    .filter((file) => !isTokensFile(file))
    .filter((file) => file.endsWith('.css'));
  const offenders = findMatches(styleSheets, DURATION_LITERAL_PATTERN);

  assert.deepEqual(
    offenders,
    [],
    `时长应引用 --duration-* 令牌，不得写字面量：\n${offenders
      .map((item) => `  ${item.file}:${String(item.line)} ${item.content}`)
      .join('\n')}`,
  );
});

test('令牌文件之外不出现数字 z-index（层级必须走 --z-*）', () => {
  // 层级冲突不会报错，只会表现为「某个弹窗被另一个盖住」，而且在单组件测试里
  // 完全看不见。集中成三档是唯一能预防它的做法。
  const styleSheets = collectApplicationFiles()
    .filter((file) => !isTokensFile(file))
    .filter((file) => file.endsWith('.css'));
  const offenders = findMatches(styleSheets, NUMERIC_Z_INDEX_PATTERN);

  assert.deepEqual(
    offenders,
    [],
    `层级应引用 --z-* 令牌，不得写数字：\n${offenders
      .map((item) => `  ${item.file}:${String(item.line)} ${item.content}`)
      .join('\n')}`,
  );
});

test('令牌文件之外不出现数字圆角（圆角必须走 --radius-* 或 50%）', () => {
  // 丸形（Badge、进度条）与几何圆角是两回事，但它们都只能来自令牌——
  // 否则「所有圆角来自三档 + 一个丸形」这套约束就退化成了约定。
  const styleSheets = collectApplicationFiles()
    .filter((file) => !isTokensFile(file))
    .filter((file) => file.endsWith('.css'));
  const offenders = findMatches(styleSheets, NUMERIC_RADIUS_PATTERN);

  assert.deepEqual(
    offenders,
    [],
    `圆角应引用 --radius-* 令牌（几何写法 50% 除外），不得写像素值：\n${offenders
      .map((item) => `  ${item.file}:${String(item.line)} ${item.content}`)
      .join('\n')}`,
  );
});

test('令牌文件之外不出现数字字号（字号必须走 --font-size-*）', () => {
  // 这条针对的是「档位外的孤立取值」：原型 `.tag` 的 11px 就是这样来的——
  // 单看每个值都合理，合起来就是一套没人控制的字阶。
  const styleSheets = collectApplicationFiles()
    .filter((file) => !isTokensFile(file))
    .filter((file) => file.endsWith('.css'));
  const offenders = findMatches(styleSheets, NUMERIC_FONT_SIZE_PATTERN);

  assert.deepEqual(
    offenders,
    [],
    `字号应引用 --font-size-* 令牌，不得写字面量：\n${offenders
      .map((item) => `  ${item.file}:${String(item.line)} ${item.content}`)
      .join('\n')}`,
  );
});

test('令牌收编进度符合 §2.4：边框三色已收编，「暂不收编」项仍未预造', () => {
  const source = readProjectFile(TOKENS_FILE);

  // 批次 2 收编状态色边框，三色必须一次到位——规范明确「不单独引入一个」。
  // 正向断言存在是必要的：「漏收编」与「多收编」是两种不同的失效。
  for (const collected of [
    '--color-success-border',
    '--color-warning-border',
    '--color-danger-border',
  ]) {
    assert.ok(source.includes(collected), `${collected} 应由 UI-002 批次 2 收编`);
  }

  // 仍被明确推后的项：磨砂白涉及 §1.1 的反玻璃拟态条款，属产品决策而非实现细节。
  for (const deferred of ['--color-frost']) {
    assert.ok(!source.includes(deferred), `${deferred} 属「暂不收编」，不得预造`);
  }
});

test('环境门禁 env:check 仍全绿（无回归）', async () => {
  const { resolveNpmInvocation } = await import('../../scripts/env/npm-command.mjs');
  const { spawn } = await import('node:child_process');
  const { projectEnv } = await import('../../scripts/env/paths.mjs');

  const invocation = resolveNpmInvocation();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.prefixArgs, 'run', 'env:check'], {
      cwd: PROJECT_ROOT,
      env: projectEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: invocation.useShell,
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, output });
    });
  });

  assert.equal(result.code, 0, `env:check 应全绿：\n${result.output}`);
});
