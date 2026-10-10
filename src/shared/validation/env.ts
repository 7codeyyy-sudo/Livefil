/**
 * 服务端环境变量的读取与校验（FND-001）。
 *
 * 设计要点：
 * - 本模块是环境变量校验规则的**唯一定义源**。`next.config.ts`（构建期）、
 *   `instrumentation.ts`（服务端启动期）与单元测试都复用它，避免规则重复实现后互相漂移。
 * - 本模块不做副作用、不引入相对导入，因此既能在 Next 的构建/运行期加载，
 *   也能被 Node 内置测试运行器直接以 `.ts` 运行（Node 22 默认剥离类型）。
 * - 校验前统一去除首尾空白：`.env` 文件里的尾随空格不应让 `LOG_LEVEL` 这类枚举
 *   变量诡异地校验失败，而「变量已设置但实际为空」必须被明确拒绝。
 * - 校验失败信息只包含**变量名与原因**，绝不回显变量取值，避免密钥进入日志
 *   （NFR-SEC-002、开发环境规范 §4「日志不得打印环境变量」）。
 */
import { z } from 'zod';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** 表示「不调用外部 AI 服务」的供应商标识，也是本地开发的默认值。 */
export const MOCK_AI_PROVIDER = 'mock';

/** 部署形态（AUTH-002）：本地自用（默认）或认证部署。 */
export type AppMode = 'local' | 'cloud';

/** 邮件通道提供方（AUTH-002）：仅 dev/test 的 mock，或真实 HTTP API。 */
export type EmailProvider = 'mock' | 'http';

const DEFAULT_LOG_LEVEL: LogLevel = 'info';

const DEFAULT_AI_PROVIDER = MOCK_AI_PROVIDER;

/**
 * 受支持的数据库连接串协议。
 *
 * **为什么 `DATABASE_URL` 在本模块仍是 optional**（即便 Phase 2 已真正接入数据库）：
 * 《详细设计说明书》§8.3 冻结的是「分层必填」——根校验只保证「**一旦提供必须合法**」。
 * health、styleguide 与 CI 等入口不依赖数据库，把根校验做成必填会让这些路径整体
 * 失败（以及让每个只想渲染静态页的构建都需要一份连接串）。必填约束下沉到使用方：
 * 数据库连接工厂缺 URL 抛 `DEPENDENCY_UNAVAILABLE`，会话签名模块在装配期失败。
 */
const SUPPORTED_DATABASE_PROTOCOLS = ['postgres:', 'postgresql:'];

/** 会话密钥最小长度。过短的密钥无法提供有效的签名强度。 */
const AUTH_SECRET_MIN_LENGTH = 32;

/**
 * 同步增量拉取的默认安全滞后窗口（毫秒，SYNC-001）。
 *
 * 「只返回提交满 5 秒的变更」是规避永久漏读的手段（《接口文档》§12.1.2、
 * 《数据库设计文档》§4.18）：事务的 `change_at` 取自语句执行时刻，而提交时刻更晚，
 * 客户端若已把游标推到那条尚未可见的 `change_at` 之后，就会永久跳过它。
 */
const DEFAULT_SYNC_PULL_LAG_MS = 5000;

/**
 * AI 相关默认值（RD-20260929-006 §1.6 表格，与 spike 冻结值逐一对应）。
 *
 * 只在「未配置」时兜底：`.env` 里写了就用写的，写错了直接报错——不做隐式纠正。
 */
const DEFAULT_AI_TIMEOUT_MS = 15_000;
const DEFAULT_AI_MAX_INPUT_CHARS = 2_000;
const DEFAULT_AI_MONTHLY_CALL_LIMIT = 200;
/** 整数分＝ 50 元。 */
const DEFAULT_AI_MONTHLY_COST_LIMIT_MINOR = 5_000;
const DEFAULT_AI_RATE_LIMIT_PER_MINUTE = 10;

/**
 * 判断字符串是否为受支持的数据库连接串。
 *
 * `new URL` 解析失败属于预期内的非法输入，显式返回 false；
 * 其他异常（例如运行时能力缺失）继续向上抛出，不做静默吞错。
 */
function isSupportedDatabaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) {
      return false;
    }
    throw error;
  }
  return SUPPORTED_DATABASE_PROTOCOLS.includes(parsed.protocol);
}

function isLogLevel(value: string): boolean {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** 去除首尾空白，并把非字符串值归一为 undefined。 */
function normalizeEnvSource(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    normalized[name] = typeof value === 'string' ? value.trim() : undefined;
  }
  return normalized;
}

/**
 * 仅要求非空的字符串变量（该变量没有其他校验规则）。
 */
const notEmptyString = (variableName: string) =>
  z.string().refine((value) => value.length > 0, {
    message: `${variableName} 不能是空字符串或纯空白`,
  });

/**
 * 非负整数型变量（毫秒数、条数、金额最小单位）。
 *
 * 写成字符串再转数字，理由同 `SYNC_PULL_LAG_MS`：`z.coerce.number()` 会把
 * `''`（→ 0）、`'5s'`（→ NaN）一并悄悄接受或产生误导性错误，而把「每月调用上限」
 * 配成 0 恰恰会让所有 AI 调用被拒。`^\d+$` 只放行纯数字串。
 */
const nonNegativeIntegerEnv = (variableName: string) =>
  z
    .string()
    .refine((value) => /^\d+$/.test(value), {
      message: `${variableName} 必须是非负整数，且不能为空`,
    })
    .transform((value) => Number(value));

/**
 * 校验规则的组织原则：**每个变量只允许一条规则**。
 *
 * 早期版本对 LOG_LEVEL 同时挂了「非空」与「枚举」两条规则，空值时会为同一个变量
 * 报出两条重复错误（DATABASE_URL、AUTH_SECRET 同样受影响）。因此这里把「非空」
 * 合并进该变量唯一的规则里，保证一个变量最多产生一条可定位的错误。
 * 归一化阶段已去除首尾空白，故判定空值只需比较长度。
 */
const serverEnvSchema = z
  .object({
    NODE_ENV: notEmptyString('NODE_ENV').optional(),
    LOG_LEVEL: z
      .string()
      .refine(isLogLevel, {
        message: `LOG_LEVEL 取值必须是 ${LOG_LEVELS.join(' | ')} 之一，且不能为空`,
      })
      .transform((value) => value as LogLevel)
      .optional(),
    DATABASE_URL: z
      .string()
      .refine(isSupportedDatabaseUrl, {
        message: `DATABASE_URL 必须是 ${SUPPORTED_DATABASE_PROTOCOLS.join(' 或 ')} 开头的连接串，且不能为空`,
      })
      .optional(),
    /**
     * 真机数据库测试专用的**测试库**连接串（IAM-004）。
     *
     * 与 `DATABASE_URL` 分开而不是复用后者：真机测试会做空库迁移与事务回滚，
     * 指向开发库等于把开发数据洗一遍。同样是「提供即校验、不提供不报错」——
     * 默认的 `check` 链必须在没有任何数据库的环境下也能跑完。
     */
    TEST_DATABASE_URL: z
      .string()
      .refine(isSupportedDatabaseUrl, {
        message: `TEST_DATABASE_URL 必须是 ${SUPPORTED_DATABASE_PROTOCOLS.join(' 或 ')} 开头的连接串，且不能为空`,
      })
      .optional(),
    AUTH_SECRET: z
      .string()
      .refine((value) => value.length >= AUTH_SECRET_MIN_LENGTH, {
        message: `AUTH_SECRET 长度至少为 ${AUTH_SECRET_MIN_LENGTH} 个字符`,
      })
      .optional(),
    /**
     * 部署形态开关（AUTH-002，RD-012 §5.1，验收红线的判据来源）。
     *
     * 缺省 `local`——开发、CI、本地自用部署零配置即维持现状（local 分支行为
     * 与现网逐字节一致）；`cloud` 为认证部署，关闭自动本地会话并启用 `/auth/cloud/*`。
     * 选 env 而非初始化判据：部署形态是部署期事实，与 OPS-006「环境变量和密钥
     * 分离」同层；隐式判据（如「配了邮件即 cloud」）会让配置与行为无声漂移。
     */
    APP_MODE: z
      .string()
      .refine((value) => value === 'local' || value === 'cloud', {
        message: 'APP_MODE 取值必须是 local 或 cloud',
      })
      .transform((value) => value as AppMode)
      .optional(),
    /**
     * 邮件通道提供方（AUTH-002，RD-012 §8.3）。
     * `mock` 仅 dev/test 可用：不真正发信、不回传验证码（不做 devCode 后门）；
     * 集成测试注入 fake `EmailSender` 端口取码。
     */
    EMAIL_PROVIDER: z
      .string()
      .refine((value) => value === 'mock' || value === 'http', {
        message: 'EMAIL_PROVIDER 取值必须是 mock 或 http',
      })
      .transform((value) => value as EmailProvider)
      .optional(),
    EMAIL_API_URL: z
      .string()
      .refine((value) => /^https?:\/\/\S+$/.test(value), {
        message: 'EMAIL_API_URL 必须是 http:// 或 https:// 开头的地址，且不能为空',
      })
      .optional(),
    EMAIL_API_KEY: notEmptyString('EMAIL_API_KEY').optional(),
    EMAIL_FROM: notEmptyString('EMAIL_FROM').optional(),
    /**
     * 邀请码白名单（PD-029 拍板「1+2」第 2 项：邀请码制注册，决策清单 L113
     * 邀请制建议回归）。
     *
     * 逗号分隔的随机码（部署侧生成，**建议 8 位以上随机**——熵要求入安全矩阵，
     * spike §6.2 丙案项转正）。**未配置 ＝ 空集合 ＝ 所有邀请码拒绝**：邀请码制
     * 注册的自然结果，生产必须配码才能注册（对齐 OPS-007 5–20 人控量）。作废／
     * 轮换＝改配置重启（内测量级可接受）；`invitations` 全版表结构候补不进本批。
     *
     * 解析只做 trim + 小写归一 + 滤空（比对时对输入同样归一，大小写不敏感）；
     * 不强校验每个码的长度——长度是部署侧的熵建议，误拒合法短码比放过更糟。
     */
    INVITE_CODES: z.string().optional(),
    /**
     * 同步拉取的安全滞后窗口（毫秒，SYNC-001）。
     *
     * 与其余变量同样「提供即校验、不提供不报错」：缺省时用
     * {@link DEFAULT_SYNC_PULL_LAG_MS}。写成字符串再转数字，是因为环境变量本身
     * 只有字符串形态——用 `z.coerce.number()` 会把 `'5s'`、`''`、`' 12 '` 一并
     * 悄悄接受（`Number('')` 是 0），而一个把滞后窗口设成 0 的部署恰恰会打开漏读窗口。
     */
    SYNC_PULL_LAG_MS: z
      .string()
      .refine((value) => /^\d+$/.test(value), {
        message: 'SYNC_PULL_LAG_MS 必须是非负整数（毫秒），且不能为空',
      })
      .transform((value) => Number(value))
      .optional(),
    AI_PROVIDER: notEmptyString('AI_PROVIDER').optional(),
    AI_API_KEY: notEmptyString('AI_API_KEY').optional(),
    /**
     * OpenAI 兼容协议的基址（RD-20260929-006 §1.6）。
     *
     * 只在此处校验「是个 http(s) 地址」；「是否允许明文 http」是**跨字段**规则
     * （要读 `AI_ALLOW_INSECURE_BASE_URL`），放在下面的对象级 refine 里。
     */
    AI_BASE_URL: z
      .string()
      .refine((value) => /^https?:\/\/\S+$/.test(value), {
        message: 'AI_BASE_URL 必须是 http:// 或 https:// 开头的地址，且不能为空',
      })
      .optional(),
    /** 模型名。不硬编码在代码里，换档位只改配置。 */
    AI_MODEL: notEmptyString('AI_MODEL').optional(),
    /** 单次调用超时（毫秒），经 `AbortSignal.timeout`。默认 15000。 */
    AI_TIMEOUT_MS: nonNegativeIntegerEnv('AI_TIMEOUT_MS').optional(),
    /** 脱敏截断长度。默认 2000。 */
    AI_MAX_INPUT_CHARS: nonNegativeIntegerEnv('AI_MAX_INPUT_CHARS').optional(),
    /** 每用户每月调用上限。默认 200。 */
    AI_MONTHLY_CALL_LIMIT: nonNegativeIntegerEnv('AI_MONTHLY_CALL_LIMIT').optional(),
    /** 每用户每月成本上限（整数分）。默认 5000。 */
    AI_MONTHLY_COST_LIMIT_MINOR: nonNegativeIntegerEnv('AI_MONTHLY_COST_LIMIT_MINOR').optional(),
    /** 短窗口限流（每分钟）。默认 10。 */
    AI_RATE_LIMIT_PER_MINUTE: nonNegativeIntegerEnv('AI_RATE_LIMIT_PER_MINUTE').optional(),
    /**
     * 允许明文 `http` 基址的显式开关，默认关闭。
     *
     * 只接受 `1` / `0`（兼容 `true` / `false`）：这是安全开关，含糊的取值
     * （如 `'yes'`）必须报错而不是被当成 truthy 悄悄放行——放行一次，
     * 密钥与用户内容就会明文出网。
     */
    AI_ALLOW_INSECURE_BASE_URL: z
      .string()
      .refine((value) => value === '1' || value === '0' || value === 'true' || value === 'false', {
        message: 'AI_ALLOW_INSECURE_BASE_URL 必须是 1 或 0（也接受 true / false）',
      })
      .transform((value) => value === '1' || value === 'true')
      .optional(),
  })
  // 条件必填：只有真正调用外部 AI 时才要求密钥，本地 mock 模式不强迫开发者配置密钥。
  //
  // 「非空」是这里的前置条件，而不是顺手多报一条的理由：当 AI_PROVIDER 本身就是
  // 空值（非法配置）时，再要求 AI_API_KEY 只会产生误导性的附加错误，
  // 使用者应当先修好 AI_PROVIDER。因此仅当供应商被真正配置为非 mock 值时才触发本规则。
  .refine(
    (value) => {
      const provider = value.AI_PROVIDER;
      const usesExternalProvider =
        provider !== undefined && provider.length > 0 && provider !== MOCK_AI_PROVIDER;
      return !usesExternalProvider || value.AI_API_KEY !== undefined;
    },
    { message: `AI_API_KEY: 当 AI_PROVIDER 不是 ${MOCK_AI_PROVIDER} 时必须配置` },
  )
  // 跨字段安全规则：默认拒绝明文 `http` 基址。
  //
  // 放在对象级而不是 `AI_BASE_URL` 的变量级，是因为它必须读到另一个变量
  // （`AI_ALLOW_INSECURE_BASE_URL`）。密钥与用户内容明文出网的代价不可逆，
  // 因此放行必须是一次**显式**的配置动作，而不是「有人写了 http 也能跑」。
  .refine(
    (value) =>
      !(
        value.AI_BASE_URL?.startsWith('http://') === true &&
        value.AI_ALLOW_INSECURE_BASE_URL !== true
      ),
    {
      message:
        'AI_BASE_URL: 明文 http 仅在本机开发时允许，且必须同时设置 AI_ALLOW_INSECURE_BASE_URL=1',
    },
  )
  // 邮件通道条件必填（AUTH-002，RD-012 §8.3）：`EMAIL_PROVIDER=http` 时三件套必须齐全。
  //
  // 与 `AI_API_KEY` 同一先例——条件放在对象级才能读到 `EMAIL_PROVIDER` 的取值；
  // 缺配置的失败发生在装配期（启动即暴露），而不是首个发码请求时才炸。
  .refine(
    (value) =>
      value.EMAIL_PROVIDER !== 'http' ||
      (value.EMAIL_API_URL !== undefined &&
        value.EMAIL_API_KEY !== undefined &&
        value.EMAIL_FROM !== undefined),
    {
      message: 'EMAIL_API_URL / EMAIL_API_KEY / EMAIL_FROM: 当 EMAIL_PROVIDER=http 时必须同时配置',
    },
  )
  // 反向绑定（PD-029 第 3 项，与上一条构成双向）：配置了邮件三件任一 ⇒ 必须
  // `EMAIL_PROVIDER=http`。
  //
  // 双向绑定的目的：让 `EMAIL_PROVIDER=http ⟺ 三件套齐 ⟺ EMAIL_API_URL 已配置`
  // 在**通过校验的前提下**成立——于是降级态判据 `EMAIL_API_URL !== undefined`
  // （单一分支点）不会与「实际走哪个发信分支」脱节。半配置（配了 URL 却留
  // provider 缺省 mock）在启动期就被拒绝，而不是运行期表现为「UI 显示可发信、
  // 实际静默不发」的配置与行为不一致。
  .refine(
    (value) =>
      (value.EMAIL_API_URL === undefined &&
        value.EMAIL_API_KEY === undefined &&
        value.EMAIL_FROM === undefined) ||
      value.EMAIL_PROVIDER === 'http',
    {
      message:
        'EMAIL_API_URL / EMAIL_API_KEY / EMAIL_FROM: 配置任一之前必须设置 EMAIL_PROVIDER=http（半配置会导致配置与行为不一致）',
    },
  )
  // 生产红线（AUTH-002，RD-012 §8.3；PD-029 第 3 项调整为**显式判定**）：
  // 认证部署的生产环境禁用**显式** mock 邮件通道。
  //
  // PD-029 拍板「1+2」第 3 项把「无邮件配置」确立为**合法降级态**（登录先行、
  // 域名待商榷、Resend 未到位）——降级态下 `EMAIL_PROVIDER` 缺省为 mock 但
  // `EMAIL_API_URL` 未配置，**本就不发信也不提供发信入口**（配置与行为一致），
  // 因此判据从 `?? 'mock'`（缺省也拒）收窄为**显式 `=== 'mock'`**：
  // 只有「生产 + 认证部署 + 明确要求走 mock 发信」这一真正的配置漂移才在启动
  // 拒绝。降级态与全形态的分界由单一分支点 `EMAIL_API_URL` 承担（见
  // {@link ServerEnv.emailEnabled}）。
  //
  // dev/test 下 cloud+mock 合法（集成测试注入 fake 端口取码），只有
  // 「生产 + 认证部署 + 显式 mock」三者同时成立才在启动时拒绝。
  .refine(
    (value) =>
      !(
        (value.APP_MODE ?? 'local') === 'cloud' &&
        value.NODE_ENV === 'production' &&
        value.EMAIL_PROVIDER === 'mock'
      ),
    {
      message:
        'EMAIL_PROVIDER: 生产环境的认证部署（APP_MODE=cloud）不得显式设为 mock（降级态请不配置邮件项，全形态请设为 http 并配齐三件套）',
    },
  );

/** 校验通过后的服务端环境变量视图。可选变量未配置时保持 undefined，不做隐式占位。 */
export interface ServerEnv {
  readonly nodeEnv: string;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string | undefined;
  readonly testDatabaseUrl: string | undefined;
  readonly authSecret: string | undefined;
  readonly aiProvider: string;
  readonly aiApiKey: string | undefined;
  readonly aiBaseUrl: string | undefined;
  readonly aiModel: string | undefined;
  /** 单次调用超时（毫秒）。缺省 15000。 */
  readonly aiTimeoutMs: number;
  /** 脱敏截断长度。缺省 2000。 */
  readonly aiMaxInputChars: number;
  /** 每用户每月调用上限。缺省 200。 */
  readonly aiMonthlyCallLimit: number;
  /** 每用户每月成本上限（整数分）。缺省 5000。 */
  readonly aiMonthlyCostLimitMinor: number;
  /** 短窗口限流（每分钟）。缺省 10。 */
  readonly aiRateLimitPerMinute: number;
  /** 是否允许明文 `http` 基址。缺省 false。 */
  readonly aiAllowInsecureBaseUrl: boolean;
  /** 同步拉取的安全滞后窗口（毫秒）。缺省 5000。 */
  readonly syncPullLagMs: number;
  /** 部署形态（AUTH-002）。缺省 `local`——本地自用/开发/CI 零配置维持现状。 */
  readonly appMode: AppMode;
  /** 邮件通道提供方（AUTH-002）。缺省 `mock`。 */
  readonly emailProvider: EmailProvider;
  readonly emailApiUrl: string | undefined;
  readonly emailApiKey: string | undefined;
  readonly emailFrom: string | undefined;
  /**
   * 邮件通道是否启用（PD-029 第 3 项的**单一分支点**）。
   *
   * `EMAIL_API_URL` 已配置即 true（全形态：三步注册／验证码登录 Tab／自助重置
   * 自动回归）；未配置即 false（降级态：注册免验证、验证码 Tab 隐藏、忘记密码
   * →「联系管理员重置」）。反向绑定 refine 保证此值与「实际发信分支」一致
   * （配了 URL 必为 http 通道），前端与用例只读这一个布尔，不散落硬编码判断。
   */
  readonly emailEnabled: boolean;
  /**
   * 邀请码白名单（PD-029 第 2 项）：trim + 小写归一后的非空集合。
   * 未配置 ＝ 空集合 ＝ 所有邀请码拒绝。
   */
  readonly inviteCodes: readonly string[];
}

/** 环境变量校验失败。`issues` 每项形如「变量名: 原因」，不含变量取值。 */
export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`环境变量校验失败，共 ${issues.length} 项：\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/** 把校验问题转换为稳定、可定位且不回显取值的文本。 */
function formatIssue(issue: z.ZodIssue): string {
  if (issue.path.length === 0) {
    // 对象级规则（如 AI_API_KEY 的条件必填）已在消息内写明变量名，
    // 这里不再补空前缀，避免出现「环境变量: AI_API_KEY: ...」这类冗余。
    return issue.message;
  }
  return `${issue.path.join('.')}: ${issue.message}`;
}

/**
 * 校验并归一化服务端环境变量。
 *
 * @param source 环境变量来源，通常为 `process.env`；显式传参便于测试。
 * @returns 归一化后的只读视图。
 * @throws {EnvValidationError} 存在非法取值或缺失条件必填项时抛出，一次性列出全部问题。
 */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(normalizeEnvSource(source));
  if (!result.success) {
    throw new EnvValidationError(result.error.issues.map(formatIssue));
  }

  const parsed = result.data;
  return Object.freeze({
    nodeEnv: parsed.NODE_ENV ?? 'development',
    logLevel: parsed.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    testDatabaseUrl: parsed.TEST_DATABASE_URL,
    authSecret: parsed.AUTH_SECRET,
    aiProvider: parsed.AI_PROVIDER ?? DEFAULT_AI_PROVIDER,
    aiApiKey: parsed.AI_API_KEY,
    aiBaseUrl: parsed.AI_BASE_URL,
    aiModel: parsed.AI_MODEL,
    aiTimeoutMs: parsed.AI_TIMEOUT_MS ?? DEFAULT_AI_TIMEOUT_MS,
    aiMaxInputChars: parsed.AI_MAX_INPUT_CHARS ?? DEFAULT_AI_MAX_INPUT_CHARS,
    aiMonthlyCallLimit: parsed.AI_MONTHLY_CALL_LIMIT ?? DEFAULT_AI_MONTHLY_CALL_LIMIT,
    aiMonthlyCostLimitMinor:
      parsed.AI_MONTHLY_COST_LIMIT_MINOR ?? DEFAULT_AI_MONTHLY_COST_LIMIT_MINOR,
    aiRateLimitPerMinute: parsed.AI_RATE_LIMIT_PER_MINUTE ?? DEFAULT_AI_RATE_LIMIT_PER_MINUTE,
    aiAllowInsecureBaseUrl: parsed.AI_ALLOW_INSECURE_BASE_URL ?? false,
    syncPullLagMs: parsed.SYNC_PULL_LAG_MS ?? DEFAULT_SYNC_PULL_LAG_MS,
    appMode: parsed.APP_MODE ?? 'local',
    emailProvider: parsed.EMAIL_PROVIDER ?? 'mock',
    emailApiUrl: parsed.EMAIL_API_URL,
    emailApiKey: parsed.EMAIL_API_KEY,
    emailFrom: parsed.EMAIL_FROM,
    // 单一分支点（PD-029 第 3 项）：只看 EMAIL_API_URL 是否配置。
    emailEnabled: parsed.EMAIL_API_URL !== undefined,
    // 归一在解析层做一次（比对时对输入同样归一）：trim + 小写 + 滤空。
    inviteCodes: (parsed.INVITE_CODES ?? '')
      .split(',')
      .map((code) => code.trim().toLowerCase())
      .filter((code) => code.length > 0),
  });
}
