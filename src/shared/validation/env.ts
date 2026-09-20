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
    AI_PROVIDER: notEmptyString('AI_PROVIDER').optional(),
    AI_API_KEY: notEmptyString('AI_API_KEY').optional(),
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
  });
}
