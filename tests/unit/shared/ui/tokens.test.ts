/**
 * 设计令牌的单元测试（UI-001）。
 *
 * 这一层**直接解析 `tokens.css` 源文件**，逐个比对《UI 页面规范》v0.3 §2.4 的取值。
 * 为什么不去读构建产物：Next 的生产构建会压缩颜色（实测 `#ffffff` → `#fff`），
 * 因此「取值是否与规范一致」只能在**源文件**上判定；而「令牌是否真的生效」
 * 由 `tests/e2e/tokens.spec.ts` 在真实浏览器里判定。两层各管一件事。
 *
 * 比对颜色时按**语义**归一（大小写、3 位与 6 位 hex 等价），不比对字面量——
 * 格式化的差异不是设计差异。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const TOKENS_FILE = fileURLToPath(
  new URL('../../../../src/shared/ui/styles/tokens.css', import.meta.url),
);

/** §2.4「基础语义色（9）」+「派生/辅助色（9）」的权威取值。 */
const EXPECTED_COLOR_TOKENS = {
  /* §2.1 基础语义色 */
  '--color-bg-page': '#f7f7f5',
  '--color-surface': '#ffffff',
  '--color-text-primary': '#1d1d1f',
  '--color-text-secondary': '#6e6e73',
  '--color-border': '#e5e5e2',
  '--color-accent': '#1769e0',
  '--color-success': '#2d8a5b',
  '--color-warning': '#b7791f',
  '--color-danger': '#c0392b',
  /* §2.4 派生与辅助 */
  '--color-surface-soft': '#f0f0ed',
  '--color-text-placeholder': '#a2a2a7',
  '--color-on-accent': '#ffffff',
  '--color-accent-soft': '#eaf1ff',
  '--color-focus-ring': 'rgba(23, 105, 224, 0.28)',
  '--color-overlay': 'rgba(29, 29, 31, 0.28)',
  '--color-success-soft': 'rgba(45, 138, 91, 0.08)',
  '--color-warning-soft': 'rgba(183, 121, 31, 0.08)',
  '--color-danger-soft': 'rgba(192, 57, 43, 0.08)',
  /* §2.4 状态色边框（v0.5 定值，UI-002 批次 2 收编）：语义色 24% alpha。 */
  '--color-success-border': 'rgba(45, 138, 91, 0.24)',
  '--color-warning-border': 'rgba(183, 121, 31, 0.24)',
  '--color-danger-border': 'rgba(192, 57, 43, 0.24)',

  /* §2.1 分类色族（v0.17，随 IAM-003 的生活领域收编）：与状态语义色分家，
     只收编主色值一档。数据侧存的是语义 key，不是这些色值。 */
  '--color-cat-blue': '#3b6fd9',
  '--color-cat-green': '#2f8f6c',
  '--color-cat-amber': '#b98328',
  '--color-cat-violet': '#7a56c2',
  '--color-cat-teal': '#1f8a8f',
  '--color-cat-rose': '#c25670',

  /* §2.4 v2 形态追加（5，v0.29 UI-012）：二级边界 / 卡片扫光 / 标题渐变收尾 /
     窗格光两级。全部有本批真实消费者，两态齐备（暗色档见下方 EXPECTED_DARK_TOKENS）。 */
  '--color-border-strong': '#d9d9d5',
  '--color-beam': 'rgba(23, 105, 224, 0.5)',
  '--color-title-fade': '#77777e',
  '--color-dapple-a': 'rgba(93, 140, 255, 0.22)',
  '--color-dapple-b': 'rgba(93, 140, 255, 0.08)',
} as const;

/**
 * v0.29（UI-012）暗色档权威取值。
 *
 * 来源＝视觉方案 v2 预览稿暗色令牌逐条对应；预览稿未覆盖的三处（danger、
 * 三枚状态边框、焦点环/遮罩）按同族推导，口径写在 tokens.css 暗色块注释里。
 * 别名与材质两枚也在此表内——「暗色下翻转」的部分必须逐项锁死。
 */
const EXPECTED_DARK_TOKENS = {
  '--color-bg-page': '#111214',
  '--color-surface': '#1a1c20',
  '--color-text-primary': '#e9ebee',
  '--color-text-secondary': '#969da6',
  '--color-text-placeholder': '#626a74',
  '--color-border': '#2a2d33',
  '--color-border-strong': '#383c44',
  '--color-accent': '#5b93ff',
  '--color-accent-soft': 'rgba(91, 147, 255, 0.13)',
  '--color-on-accent': '#0a1222',
  '--color-success': '#43b877',
  '--color-warning': '#d9a04a',
  '--color-danger': '#e0645c',
  '--color-surface-soft': '#212429',
  '--color-success-soft': 'rgba(67, 184, 119, 0.13)',
  '--color-warning-soft': 'rgba(217, 160, 74, 0.13)',
  '--color-danger-soft': 'rgba(224, 100, 92, 0.13)',
  '--color-success-border': 'rgba(67, 184, 119, 0.24)',
  '--color-warning-border': 'rgba(217, 160, 74, 0.24)',
  '--color-danger-border': 'rgba(224, 100, 92, 0.24)',
  '--color-focus-ring': 'rgba(91, 147, 255, 0.32)',
  '--color-overlay': 'rgba(0, 0, 0, 0.55)',
  '--color-beam': 'rgba(91, 147, 255, 0.7)',
  '--color-title-fade': '#8b929b',
  '--color-dapple-a': 'rgba(91, 147, 255, 0.18)',
  '--color-dapple-b': 'rgba(91, 147, 255, 0.06)',
  '--color-bg-figure': '#2e3238',
  '--color-primary-surface': '#e9ebee',
  '--color-primary-hover': '#ffffff',
  '--color-on-primary': '#0a1222',
  '--color-on-danger': '#0a1222',
  '--noise-opacity': '0.05',
  '--noise-blend': 'soft-light',
} as const;

/** §2.4「只允许这两处阴影」。 */
const EXPECTED_SHADOW_TOKENS = {
  '--shadow-overlay': '0 16px 44px rgba(29, 29, 31, 0.1)',
  '--shadow-raised': '0 1px 4px rgba(29, 29, 31, 0.06)',
} as const;

/** §2.2 五级字阶：字号 / 字重 / 行高（值与 §2.2 表格逐行对应）。 */
const EXPECTED_TYPE_SCALE = [
  {
    role: '页面标题',
    size: '--font-size-page-title',
    weight: '--font-weight-medium',
    lineHeight: '--line-height-page-title',
  },
  {
    role: '区域标题',
    size: '--font-size-section-title',
    weight: '--font-weight-medium',
    lineHeight: '--line-height-section-title',
  },
  {
    role: '正文',
    size: '--font-size-body',
    weight: '--font-weight-regular',
    lineHeight: '--line-height-body',
  },
  {
    role: '辅助文字',
    size: '--font-size-caption',
    weight: '--font-weight-regular',
    lineHeight: '--line-height-caption',
  },
  {
    role: '数字摘要',
    size: '--font-size-figure',
    weight: '--font-weight-medium',
    lineHeight: '--line-height-figure',
  },
] as const;

/** §2.2 明确「第一阶段仅使用 400 和 500 两种字重」。 */
const EXPECTED_FONT_WEIGHTS = {
  '--font-weight-regular': '400',
  '--font-weight-medium': '500',
} as const;

/**
 * §2.3 / §2.4 圆角。
 *
 * 前三档是**几何圆角**（矩形表面的曲率），`--radius-pill` 是「端帽完全圆化」
 * 的形态成语（Badge、进度条），两者不是同一维度的取值——所以这里的断言是
 * 「取值正确」，而不是「四个档位」。
 */
const EXPECTED_RADIUS_TOKENS = {
  '--radius-sm': '10px',
  // v0.29（UI-012）：卡片与表面一档由 14px 升为 16px（v2 卡片体系定稿）。
  '--radius-md': '16px',
  '--radius-lg': '20px',
  '--radius-pill': '999px',
} as const;

/**
 * 把颜色值归一成语义等价形式，便于比较。
 *
 * 处理三类写法差异：① 大小写（Prettier 会转小写）② 3 位与 6 位 hex 等价
 * ③ `rgba(...)` 内部的空白差异。
 */
function normalizeColor(value: string): string {
  const lowered = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(lowered);
  const digits = hex?.[1];

  if (digits !== undefined) {
    const expanded =
      digits.length === 3
        ? digits
            .split('')
            .map((character) => `${character}${character}`)
            .join('')
        : digits;
    return `#${expanded}`;
  }

  return lowered.replace(/\s+/g, '');
}

/**
 * 从 CSS 文本中提取自定义属性声明。
 *
 * 只用正则而不引 CSS 解析器：令牌文件的结构由我们自己控制（扁平的 `:root` 声明），
 * 为它引入依赖不划算。这也让「检查器」保持可读。
 */
function parseCustomProperties(css: string): Map<string, string> {
  const properties = new Map<string, string>();

  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      properties.set(name, value.replace(/\s+/g, ' ').trim());
    }
  }

  return properties;
}

/**
 * 找出预期存在但实际缺失（或取值不符）的令牌。
 *
 * 抽成独立函数是为了能被**反例验证**：单测里会喂一份故意缺令牌的样本，
 * 断言这个函数确实报得出来。检查器本身必须被检查——
 * 「什么都没查到」既可能是真干净，也可能是检查器坏了。
 */
function findTokenMismatches(
  actual: ReadonlyMap<string, string>,
  expected: Readonly<Record<string, string>>,
  equals: (actualValue: string, expectedValue: string) => boolean = (a, b) => a === b,
): string[] {
  const mismatches: string[] = [];

  for (const [name, expectedValue] of Object.entries(expected)) {
    const actualValue = actual.get(name);
    if (actualValue === undefined) {
      mismatches.push(`${name} 缺失`);
      continue;
    }
    if (!equals(actualValue, expectedValue)) {
      mismatches.push(`${name} 期望 ${expectedValue}，实际 ${actualValue}`);
    }
  }

  return mismatches;
}

const tokensSource = readFileSync(TOKENS_FILE, 'utf8');

/**
 * 浅色档令牌一律取**首个 `:root` 块**的声明。
 *
 * 不能解析整份文件：v0.29（UI-012）起文件末尾的 `html[data-theme='dark']`
 * 块会声明同名令牌，整文件解析时「后者覆盖前者」，浅色期望值会被暗色值顶掉——
 * 那是解析口径的错误，不是设计漂移。暗色档单独解析（见下方主题用例）。
 */
const rootBlock = /^:root\s*\{([^}]*)\}/m.exec(tokensSource)?.[1] ?? tokensSource;
const tokens = parseCustomProperties(rootBlock);

describe('设计令牌 · 颜色', () => {
  it('32 个颜色令牌全部存在且取值与规范语义一致', () => {
    const mismatches = findTokenMismatches(
      tokens,
      EXPECTED_COLOR_TOKENS,
      (a, b) => normalizeColor(a) === normalizeColor(b),
    );

    expect(mismatches).toEqual([]);
    expect(Object.keys(EXPECTED_COLOR_TOKENS)).toHaveLength(32);
  });

  it('颜色契约是「基础 9 + 派生 9 + 状态边框 3 + 分类色 6 + v2 追加 5」', () => {
    const names = Object.keys(EXPECTED_COLOR_TOKENS);
    // 判据必须限定到三个状态色：基础语义色里本来就有 `--color-border`（分隔线），
    // 用 `endsWith('-border')` 会把它也算成状态边框，于是基础色少一个、边框多一个。
    const borders = names.filter((name) => /-(success|warning|danger)-border$/.test(name));
    const derived = names.filter((name) =>
      /-(soft|placeholder|on-accent|focus-ring|overlay)$/.test(name),
    );
    // 分类色是 v0.17 新增的独立一族（`--color-cat-*`）。它必须从「基础语义色」
    // 里排除出去，否则 base 会变成 15——而 base 的 9 是可枚举、可解释的，
    // 混入一族只为特定功能服务的颜色会让那个数字失去意义。
    const categorical = names.filter((name) => name.startsWith('--color-cat-'));
    // v2 形态追加（v0.29，UI-012）：二级边界 / 扫光 / 标题渐变收尾 / 窗格光两级。
    // 它们不属于上面任一语义组，单列一组，避免落进 base 把 9 撑大。
    const v2Additions = [
      '--color-border-strong',
      '--color-beam',
      '--color-title-fade',
      '--color-dapple-a',
      '--color-dapple-b',
    ];
    const base = names.filter(
      (name) =>
        !borders.includes(name) &&
        !derived.includes(name) &&
        !categorical.includes(name) &&
        !v2Additions.includes(name),
    );

    // 计数写死在这里是有意的：§2.4 把令牌分组定为契约，
    // 将来若增减令牌，这条会强迫改动者回来确认总数，而不是悄悄漂移。
    expect(base).toHaveLength(9);
    expect(derived).toHaveLength(9);
    expect(borders).toHaveLength(3);
    expect(categorical).toHaveLength(6);
    expect(v2Additions).toHaveLength(5);
    expect(names).toHaveLength(32);
  });

  it('状态色柔和底按 8% alpha 推导，accent-soft 保留原型定值', () => {
    // 采样一个即可覆盖规则：三个状态色的推导方式相同，且规范只对 accent 例外。
    // 这里刻意断言**规则**而不是重复三个数字——重复会让将来改规则时漏改一处。
    expect(normalizeColor(tokens.get('--color-success-soft') ?? '')).toBe(
      normalizeColor('rgba(45, 138, 91, 0.08)'),
    );
    expect(normalizeColor(tokens.get('--color-accent-soft') ?? '')).toBe(normalizeColor('#eaf1ff'));
  });
});

/**
 * §2.4「组件别名令牌」（v0.4 引入，v0.6 补 on-danger）。
 *
 * 别名只引用既有色板取值、不引入新颜色，因此**不计入** 18 个颜色令牌契约；
 * 但取值仍由规范锁定，单独成表比对——别名漂移同样是设计漂移。
 */
const EXPECTED_COMPONENT_ALIASES = {
  '--color-primary-surface': '#1d1d1f',
  '--color-primary-hover': '#000000',
  '--color-on-primary': '#ffffff',
  '--color-on-danger': '#ffffff',
} as const;

describe('设计令牌 · 组件别名', () => {
  it('别名令牌存在且取值与 §2.4 别名表一致', () => {
    const mismatches = findTokenMismatches(
      tokens,
      EXPECTED_COMPONENT_ALIASES,
      (a, b) => normalizeColor(a) === normalizeColor(b),
    );

    expect(mismatches).toEqual([]);
  });

  it('别名不计入 18 个颜色契约（防止有人把别名混进 EXPECTED_COLOR_TOKENS）', () => {
    const contractNames = Object.keys(EXPECTED_COLOR_TOKENS);
    for (const alias of Object.keys(EXPECTED_COMPONENT_ALIASES)) {
      expect(contractNames).not.toContain(alias);
    }
  });
});

describe('设计令牌 · 阴影', () => {
  it('两个阴影令牌存在且取值与规范一致', () => {
    const mismatches = findTokenMismatches(
      tokens,
      EXPECTED_SHADOW_TOKENS,
      (a, b) => normalizeColor(a.replace(/\s+/g, '')) === normalizeColor(b.replace(/\s+/g, '')),
    );

    expect(mismatches).toEqual([]);
  });
});

describe('设计令牌 · 字体', () => {
  it('五级字阶的字号、字重、行高令牌齐备', () => {
    const required = EXPECTED_TYPE_SCALE.flatMap((scale) => [
      scale.size,
      scale.weight,
      scale.lineHeight,
    ]);

    const missing = required.filter((name) => !tokens.has(name));

    expect(missing).toEqual([]);
  });

  it('字号落在《UI 页面规范》§2.2 给定的区间内', () => {
    // 规范给的是区间（如正文 14–16px），具体取值可自选，但**不得越界**。
    const ranges = {
      '--font-size-page-title': [40, 44], // 规范 v0.27 起 40–44px（UI-011，2026-10-09 用户授权同步）
      '--font-size-section-title': [18, 20],
      '--font-size-body': [14, 16],
      '--font-size-caption': [12, 13],
      '--font-size-figure': [24, 32],
    } as const;

    for (const [name, [min, max]] of Object.entries(ranges)) {
      const value = Number.parseFloat(tokens.get(name) ?? '');
      expect(Number.isFinite(value), `${name} 应为可解析的像素值`).toBe(true);
      expect(value, `${name} 应落在 ${String(min)}–${String(max)}px 区间内`).toBeGreaterThanOrEqual(
        min,
      );
      expect(value).toBeLessThanOrEqual(max);
    }
  });

  it('只使用 400 与 500 两种字重', () => {
    expect(findTokenMismatches(tokens, EXPECTED_FONT_WEIGHTS)).toEqual([]);

    const weightTokens = [...tokens.keys()].filter((name) => name.startsWith('--font-weight-'));
    expect(weightTokens).toHaveLength(2);
  });

  it('字体族以系统字体栈表达，不引入外部字体', () => {
    const family = tokens.get('--font-family-base') ?? '';

    expect(family).toContain('-apple-system');
    expect(family).toContain('PingFang SC');
    expect(family).toContain('sans-serif');
    // 外部字体需要网络请求，与「不引入新的第三方服务」冲突。
    expect(family).not.toMatch(/https?:|url\(/);
  });
});

describe('设计令牌 · 间距与圆角', () => {
  it('基础间距单位是 4px，全部间距令牌都是 4 的倍数', () => {
    const spacing = [...tokens.entries()].filter(([name]) => name.startsWith('--space-'));

    expect(spacing.length).toBeGreaterThan(0);

    for (const [name, value] of spacing) {
      const pixels = Number.parseFloat(value);
      expect(Number.isFinite(pixels), `${name} 应为可解析的像素值`).toBe(true);
      expect(pixels % 4, `${name}（${value}）应为 4px 的倍数`).toBe(0);
    }
  });

  it('三个几何圆角与丸形令牌的取值都与规范一致', () => {
    expect(findTokenMismatches(tokens, EXPECTED_RADIUS_TOKENS)).toEqual([]);
  });

  it('内容最大宽度为 900px', () => {
    // v0.29（UI-012）由 720px 放宽为 900px（视觉方案 v2 仪表盘式页面，
    // 推翻 v0.27 的「单列阅读行宽」口径，2026-10-10 用户采纳拍板）。
    expect(tokens.get('--layout-max-width')).toBe('900px');
  });

  it('页面内边距随断点收敛：桌面 32px、平板 24px、手机 16px', () => {
    // 取值分布在媒体查询里，因此这里直接在源文本上确认三档都存在——
    // 变量在断点下被覆盖是 CSS 的正常用法，不是"第二份取值"。
    const overrides = [...tokensSource.matchAll(/--space-page-x\s*:\s*(\d+px)/g)].map(
      (match) => match[1],
    );

    expect(overrides).toEqual(['32px', '24px', '16px']);
    expect(tokensSource).toMatch(/@media \(max-width: 1023px\)/);
    expect(tokensSource).toMatch(/@media \(max-width: 767px\)/);
  });
});

describe('设计令牌 · 主题与纪律', () => {
  it(':root 声明 color-scheme: light（默认档仍是浅色）', () => {
    expect(tokensSource).toMatch(/:root\s*\{[^}]*color-scheme:\s*light/);
  });

  it('深色档已激活：颜色族 / 别名 / 材质两枚逐项与权威取值一致', () => {
    const darkBlock = /html\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(tokensSource)?.[1];

    expect(darkBlock, '应保留 html[data-theme=dark] 块（v0.29 起为完整暗色档）').toBeDefined();

    const darkTokens = parseCustomProperties(darkBlock ?? '');

    const mismatches = findTokenMismatches(
      darkTokens,
      EXPECTED_DARK_TOKENS,
      (a, b) => normalizeColor(a) === normalizeColor(b) || a === b,
    );

    expect(mismatches).toEqual([]);
    expect(darkBlock).toMatch(/color-scheme:\s*dark/);
  });

  it('暗色两态齐备：颜色契约中除分类色外全部有暗色覆盖，分类色刻意不翻转', () => {
    const darkBlock = /html\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(tokensSource)?.[1];
    const darkTokens = parseCustomProperties(darkBlock ?? '');

    const missing = Object.keys(EXPECTED_COLOR_TOKENS).filter(
      (name) => !name.startsWith('--color-cat-') && !darkTokens.has(name),
    );

    expect(missing, '除分类色外，浅色契约里每一枚颜色都必须有暗色取值').toEqual([]);

    for (const name of Object.keys(EXPECTED_COLOR_TOKENS)) {
      if (name.startsWith('--color-cat-')) {
        expect(darkTokens.has(name), `${name} 两态同值，不应在暗色块里翻转`).toBe(false);
      }
    }
  });

  it('v0.29 新增：材质两枚与层级一枚（噪声 / 纹理层）', () => {
    expect(tokens.get('--noise-opacity')).toBe('0.028');
    expect(tokens.get('--noise-blend')).toBe('multiply');
    expect(tokens.get('--z-texture')).toBe('90');
  });

  it('不把断点做成 CSS 变量（变量无法用于 @media 条件）', () => {
    const breakpointLikeTokens = [...tokens.keys()].filter((name) =>
      /breakpoint|screen/.test(name),
    );

    expect(breakpointLikeTokens).toEqual([]);
  });
});

describe('检查器自证（阴性结果不能当证据）', () => {
  it('缺令牌的样本一定被抓出来', () => {
    const broken = new Map(tokens);
    broken.delete('--color-accent');

    const mismatches = findTokenMismatches(
      broken,
      EXPECTED_COLOR_TOKENS,
      (a, b) => normalizeColor(a) === normalizeColor(b),
    );

    expect(mismatches).toEqual(['--color-accent 缺失']);
  });

  it('取值写错的样本一定被抓出来', () => {
    const broken = new Map(tokens);
    broken.set('--color-danger', '#ff0000');

    const mismatches = findTokenMismatches(
      broken,
      EXPECTED_COLOR_TOKENS,
      (a, b) => normalizeColor(a) === normalizeColor(b),
    );

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('--color-danger');
  });

  it('颜色归一化按语义等价，不因大小写或位数差异误报', () => {
    expect(normalizeColor('#FFFFFF')).toBe(normalizeColor('#ffffff'));
    expect(normalizeColor('#FFF')).toBe(normalizeColor('#ffffff'));
    expect(normalizeColor('RGBA(23,105,224,0.28)')).toBe(
      normalizeColor('rgba(23, 105, 224, 0.28)'),
    );
  });

  it('解析器真的读到了令牌（防止"零命中即通过"）', () => {
    // 若解析器失效，上面所有断言都会因"全部缺失"而失败——但万一有人把断言改松，
    // 这一条会独立地证明解析结果非空。
    expect(tokens.size).toBeGreaterThan(30);
  });
});
