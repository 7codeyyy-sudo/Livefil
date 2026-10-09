/**
 * 服务端组合根（DB-001 / IAM-001）。
 *
 * ## 职责
 *
 * 把「环境变量 → 连接/签名器 → 仓储 → 用例」这条装配链收在一处，让 route handler
 * 只表达业务流转，而不是每次都重新拼一遍依赖。集成测试注入 fake 实现时也只需要
 * 替换这一个点。
 *
 * ## 为什么在项目根，而不是 `app/_lib/`
 *
 * 组合根是**唯一**必须同时看见"抽象"与"实现"的地方——它要 import 仓储的 Drizzle
 * 实现、数据库客户端与会话签名器。而 `tests/unit/architecture/dependency-rules.ts`
 * 的「App Router 不得直接访问领域内部与基础设施」把 `app/**` 到 `src/infrastructure`
 * 与 `src/modules/<模块>/infrastructure` 的引用全部禁掉了，理由是"页面与路由不得直接
 * 访问数据库实现"。
 *
 * 这两条要求都是对的，冲突只出在位置：组合根既不是页面也不是路由，它属于架构的
 * **最外层**——按惯例与入口同级。本仓库的最外层就是项目根（`instrumentation.ts`、
 * `next.config.ts`、`proxy.ts` 都在这一层），所以它落在这里，而不去修改那条依赖规则
 * （规则本身是架构契约，改它等同于改架构）。
 *
 * `import 'server-only'` 是必须的：它保证本模块**永远不会**被打进客户端包——
 * 一旦某个客户端组件误引用它，构建会立即失败，而不是把密钥读取逻辑悄悄泄露出去。
 *
 * ## 为什么是懒加载而不是模块顶层初始化
 *
 * `next build` 会加载路由模块（用于收集与预渲染），如果这里在模块顶层就创建
 * 连接池或签名器，那么**每一次构建都需要一份完整的环境配置**——而构建静态页
 * 与 CI 根本不需要数据库。懒加载把"缺配置"的暴露时机推到真正的使用点
 * （首个请求），同时让 §8.3 的启动期检查由 `instrumentation.ts` 显式触发。
 */
import 'server-only';

import packageJson from './package.json';

import { createSessionSigner } from '@/infrastructure/auth/session-signer.ts';
import { createDatabaseClient, type DatabaseClient } from '@/infrastructure/database/client.ts';
import { createIdempotencyStore } from '@/infrastructure/idempotency/idempotency-store.drizzle.ts';
import { createExportReader } from '@/modules/data-management/infrastructure/export-reader.drizzle.ts';
import { createImportGateway } from '@/modules/data-management/infrastructure/import-gateway.drizzle.ts';
import { createRecycleRepository } from '@/modules/data-management/infrastructure/recycle.drizzle.ts';
import { createDeletionRequestRepository } from '@/modules/data-management/infrastructure/deletion-request.drizzle.ts';
import { createInMemoryExportStore } from '@/modules/data-management/infrastructure/export-store.memory.ts';
import { createInMemoryImportPreviewStore } from '@/modules/data-management/infrastructure/import-store.memory.ts';
import type { ExportReader } from '@/modules/data-management/domain/data-ports.ts';
import type { ImportGateway } from '@/modules/data-management/domain/data-ports.ts';
import type { RecycleRepository } from '@/modules/data-management/domain/data-ports.ts';
import type { DeletionRequestRepository } from '@/modules/data-management/domain/data-ports.ts';
import type {
  ExportStore,
  ImportPreviewStore,
} from '@/modules/data-management/domain/data-ports.ts';
import { createAccountRepository } from '@/modules/identity/infrastructure/user-repository.drizzle.ts';
import { createSessionRepository } from '@/modules/identity/infrastructure/session-repository.drizzle.ts';
import { createVerificationCodeRepository } from '@/modules/identity/infrastructure/verification-code-repository.drizzle.ts';
import { createScryptPasswordHasher } from '@/modules/identity/infrastructure/password-hasher.scrypt.ts';
import { createVerificationCodeCrypto } from '@/modules/identity/infrastructure/verification-code-crypto.ts';
import { createEmailSender } from '@/modules/identity/infrastructure/email-sender.http.ts';
import { createInMemoryRateLimiter } from '@/modules/identity/infrastructure/rate-limiter.memory.ts';
import type { AccountRepository } from '@/modules/identity/domain/account-repository.ts';
import type { SessionRepository } from '@/modules/identity/domain/session.ts';
import type { VerificationCodeRepository } from '@/modules/identity/domain/verification-code.ts';
import type { PasswordHasher } from '@/modules/identity/domain/password-hasher.ts';
import type { VerificationCodeCrypto } from '@/modules/identity/domain/verification-code.ts';
import type { EmailSender } from '@/modules/identity/domain/email-sender.ts';
import type { RateLimiter } from '@/modules/identity/domain/rate-limiter.ts';
import type { AiProvider } from '@/modules/ai/domain/ai-provider.ts';
import type { AiQuotaLimits } from '@/modules/ai/domain/ai-policy.ts';
import type { AiDraftRepository } from '@/modules/ai/domain/ai-draft-repository.ts';
import type { AiUsageRepository } from '@/modules/ai/domain/ai-usage-repository.ts';
import { ConfirmAiDraftUseCase } from '@/modules/ai/application/confirm-ai-draft.ts';
import { GenerateAiDraftUseCase } from '@/modules/ai/application/generate-ai-draft.ts';
import { GetAiUsageUseCase } from '@/modules/ai/application/get-ai-usage.ts';
import { InvokeAiProviderUseCase } from '@/modules/ai/application/invoke-ai-provider.ts';
import { createAiDraftRepository } from '@/modules/ai/infrastructure/ai-draft-repository.drizzle.ts';
import { createAiUsageRepository } from '@/modules/ai/infrastructure/ai-usage-repository.drizzle.ts';
import { createMockAiProvider } from '@/modules/ai/infrastructure/providers/mock-ai-provider.ts';
import { createResilientAiProvider } from '@/modules/ai/infrastructure/providers/resilient-ai-provider.ts';
import { ManageExpenseUseCase } from '@/modules/expenses/application/manage-expense.ts';
import { ManageScheduleBlockUseCase } from '@/modules/scheduling/application/manage-scheduling.ts';
import { ManageTaskUseCase } from '@/modules/tasks/application/manage-task.ts';
import { createLogger } from '@/shared/telemetry/logger.ts';
import { DEFAULT_LIFE_AREAS } from '@/modules/life-areas/domain/default-life-areas.ts';
import { createExpenseCategoryRepository } from '@/modules/expenses/infrastructure/expense-category-repository.drizzle.ts';
import { createExpenseRepository } from '@/modules/expenses/infrastructure/expense-repository.drizzle.ts';
import type { ExpenseCategoryRepository } from '@/modules/expenses/domain/expense-category-repository.ts';
import type { ExpenseRepository } from '@/modules/expenses/domain/expense-repository.ts';
import type { LifeAreaRepository } from '@/modules/life-areas/domain/life-area-repository.ts';
import type { LifeAreaSeed } from '@/modules/life-areas/domain/life-area.ts';
import { createLifeAreaRepository } from '@/modules/life-areas/infrastructure/life-area-repository.drizzle.ts';
import type { SessionTokenService } from '@/modules/identity/domain/session-token.ts';
import type { UserRepository } from '@/modules/identity/domain/user-repository.ts';
import { createUserRepository } from '@/modules/identity/infrastructure/user-repository.drizzle.ts';
import type { GoalRepository, ActionRepository } from '@/modules/goals/domain/goal-repository.ts';
import {
  createActionRepository,
  createGoalRepository,
} from '@/modules/goals/infrastructure/goal-repository.drizzle.ts';
import type { TaskRepository } from '@/modules/tasks/domain/task-repository.ts';
import { createTaskRepository } from '@/modules/tasks/infrastructure/task-repository.drizzle.ts';
import type { ScheduleBlockRepository } from '@/modules/scheduling/domain/schedule-block-repository.ts';
import { createScheduleBlockRepository } from '@/modules/scheduling/infrastructure/schedule-block-repository.drizzle.ts';
import type { FixedCommitmentRepository } from '@/modules/scheduling/domain/fixed-commitment-repository.ts';
import { createFixedCommitmentRepository } from '@/modules/scheduling/infrastructure/fixed-commitment-repository.drizzle.ts';
import type {
  ExecutionLogRepository,
  RecoveryStateRepository,
} from '@/modules/execution/domain/execution-repository.ts';
import {
  createExecutionLogRepository,
  createRecoveryStateRepository,
} from '@/modules/execution/infrastructure/execution-repositories.drizzle.ts';
import type { RoutineRepository } from '@/modules/routines/domain/routine-repository.ts';
import { createRoutineRepository } from '@/modules/routines/infrastructure/routine-repository.drizzle.ts';
import type { NotificationRuleRepository } from '@/modules/notifications/domain/notification-rule-repository.ts';
import type { NotificationDeliveryRepository } from '@/modules/notifications/domain/notification-delivery-repository.ts';
import { createNotificationRuleRepository } from '@/modules/notifications/infrastructure/notification-rule-repository.drizzle.ts';
import { createNotificationDeliveryRepository } from '@/modules/notifications/infrastructure/notification-delivery-repository.drizzle.ts';
import type {
  ReviewAdjustmentApplier,
  ReviewFactsRepository,
  ReviewRepository,
} from '@/modules/reviews/domain/review-repository.ts';
import { createReviewFactsRepository } from '@/modules/reviews/infrastructure/review-facts.drizzle.ts';
import {
  createReviewAdjustmentApplier,
  createReviewRepository,
} from '@/modules/reviews/infrastructure/review-repository.drizzle.ts';
import type { SyncConflictRepository } from '@/modules/sync/domain/sync-conflict.ts';
import type { SyncApplyPort, SyncRepository } from '@/modules/sync/domain/sync-repository.ts';
import { createSyncApplyPort } from '@/modules/sync/infrastructure/sync-apply.drizzle.ts';
import { createSyncConflictRepository } from '@/modules/sync/infrastructure/sync-conflict-repository.drizzle.ts';
import { createSyncRepository } from '@/modules/sync/infrastructure/sync-repository.drizzle.ts';
import { InvariantError } from '@/shared/errors/app-error.ts';
import { createAuditLogger, type AuditLogger } from '@/shared/telemetry/audit-event.ts';
import { MOCK_AI_PROVIDER } from '@/shared/validation/env.ts';
import { serverEnv } from '@/shared/validation/env.server.ts';

/**
 * 审计事件里的应用版本（SRS §6.7 要求）。
 *
 * 直接读 `package.json` 而不是手写字符串：手写的版本号在每次发版时都要有人记得
 * 同步，而"审计事件带着一个过期的版本"恰恰会让它在排查时误导人。等发布流程有了
 * 构建期注入，这里换成读取注入值即可，调用点不变。
 */
const APP_VERSION: string = packageJson.version;

let databaseClient: DatabaseClient | null = null;
let sessionTokenService: SessionTokenService | null = null;
let auditLogger: AuditLogger | null = null;
let aiProvider: AiProvider | null = null;
/**
 * 认证面的单例（AUTH-002）。
 *
 * - `rateLimiter` **必须是进程级单例**：进程内滑动窗口的状态挂在实例上，
 *   每请求新建等于没有限流（RD-012 §4.2 单实例边界）。
 * - scrypt 哈希器与验证码 crypto 无跨请求状态，但共享同一 AUTH_SECRET 派生，
 *   单例省去重复派生。
 * - `emailSender` 读 `serverEnv`（模块加载时已校验），单例即可。
 */
let rateLimiter: RateLimiter | null = null;
let passwordHasher: PasswordHasher | null = null;
let verificationCodeCrypto: VerificationCodeCrypto | null = null;
let emailSender: EmailSender | null = null;
/**
 * data-management 的两个内存单例（OPS-002）。
 *
 * **必须进程级缓存**：作业与预览都是有状态的短期对象，每次请求新建等于
 * 「导出完就查不到自己的作业」。单实例边界与限流同口径（RD-015 披露）。
 */
let exportStore: ExportStore | null = null;
let importPreviewStore: ImportPreviewStore | null = null;

/** 数据库客户端单例。缺 `DATABASE_URL` 时由连接工厂抛出 `DEPENDENCY_UNAVAILABLE`。 */
function getDatabaseClient(): DatabaseClient {
  databaseClient ??= createDatabaseClient({ connectionString: serverEnv.databaseUrl });
  return databaseClient;
}

/**
 * 会话令牌服务单例。
 *
 * `instrumentation.ts` 在启动时调用一次本函数，让缺密钥的部署**启动即失败**
 * （§8.3：装配期暴露，而不是首个请求才暴露）。
 *
 * 返回类型是领域端口而不是具体实现：调用方（应用层与 API 适配层）只该知道
 * "有人能签发与验证会话"，不该知道它是 HMAC。
 */
export function getSessionTokenService(): SessionTokenService {
  sessionTokenService ??= createSessionSigner({ secret: serverEnv.authSecret });
  return sessionTokenService;
}

/** 密码哈希器单例（AUTH-002；scrypt 无跨请求状态，单例省去重复装配）。 */
export function getPasswordHasher(): PasswordHasher {
  passwordHasher ??= createScryptPasswordHasher();
  return passwordHasher;
}

/**
 * 验证码 crypto 单例（AUTH-002）。
 *
 * 与 `getSessionTokenService` 同族：缺 `AUTH_SECRET` 时**装配期失败**
 * （§8.3——启动暴露，而非首个发码请求才炸）。
 */
export function getVerificationCodeCrypto(): VerificationCodeCrypto {
  verificationCodeCrypto ??= createVerificationCodeCrypto({ secret: serverEnv.authSecret });
  return verificationCodeCrypto;
}

/** 邮件发送端口单例（AUTH-002；provider 与三件套由 env 跨字段规则约束）。 */
export function getEmailSender(): EmailSender {
  emailSender ??= createEmailSender();
  return emailSender;
}

/**
 * 限流器单例（AUTH-002）——**必须进程级共享**：
 * 进程内滑动窗口的状态挂在实例上，每请求新建等于没有限流（RD-012 §4.2）。
 * data-management 的限流消费同一实例（端口结构兼容，键按 `data:` 前缀分域）。
 */
export function getRateLimiter(): RateLimiter {
  rateLimiter ??= createInMemoryRateLimiter();
  return rateLimiter;
}

/** 导出作业内存单例（OPS-002，短期下载语义——见文件头单例理由）。 */
export function getExportStore(): ExportStore {
  exportStore ??= createInMemoryExportStore();
  return exportStore;
}

/** 导入预览内存单例（OPS-002，30 分钟时限）。 */
export function getImportPreviewStore(): ImportPreviewStore {
  importPreviewStore ??= createInMemoryImportPreviewStore();
  return importPreviewStore;
}

/** 首启播种用的领域名单（归属 `life-areas` 领域，这里只是转交）。 */
export function getLifeAreaSeeds(): readonly LifeAreaSeed[] {
  return DEFAULT_LIFE_AREAS;
}

/** 审计日志器单例（SRS §6.7 的 6 类事件经它写出，与运行日志共用脱敏规则）。 */
export function getAuditLogger(): AuditLogger {
  auditLogger ??= createAuditLogger({ appVersion: APP_VERSION });
  return auditLogger;
}

/**
 * AI provider 单例（AI-003）。
 *
 * 返回**领域端口类型**而非具体实现：调用方只该知道「有人能完成一次补全」，
 * 不该知道它是 mock 还是哪个厂商的 HTTP 适配器。
 *
 * ## 为什么在装配期就拒绝非 mock 的配置
 *
 * 真实 provider 的 HTTP 适配器与真实密钥启用**不在本批范围**（PD-20260929-018 §五，
 * 挂邀请测试期）。若这里静默返回 mock，配置成真实供应商的部署会以为自己在用真实
 * 模型——这种「配置与行为不一致」比直接起不来更难排查。因此非 mock 时显式失败。
 *
 * 用 `InvariantError` 而不是 `DependencyUnavailableError`：后者表达的是「外部依赖
 * 当下不可达」（502，调用方可以等等再试），而这里是**本机配置与本批能力不符**，
 * 属于装配期就该拦下的配置错误，与 `session-signer` 缺 `AUTH_SECRET` 同一类
 * （对外同为 500，日志侧当作待修信号）。
 *
 * ## 为什么套一层 resilience 装饰器
 *
 * 超时与重试是 provider 层的横切策略（RD-20260929-006 §1.3）；应用层不得引用
 * 基础设施实现（依赖边界规则），所以只能在这里装配好后以端口形态注入用例。
 */
export function getAiProvider(): AiProvider {
  if (aiProvider !== null) {
    return aiProvider;
  }
  if (serverEnv.aiProvider !== MOCK_AI_PROVIDER) {
    throw new InvariantError({
      message: `真实 AI provider 未在本批启用（PD-20260929-018 §五 不在范围），请保持 AI_PROVIDER=${MOCK_AI_PROVIDER}`,
      details: { variable: 'AI_PROVIDER' },
    });
  }
  aiProvider = createResilientAiProvider({
    provider: createMockAiProvider({ model: serverEnv.aiModel ?? MOCK_AI_PROVIDER }),
  });
  return aiProvider;
}

/**
 * AI 额度与限流上限（AI-003/AI-006）。
 *
 * 从 env 读一次、以领域端口类型返回：调用方（用例、路由）只关心「上限是多少」，
 * 不关心它来自哪个环境变量名。
 */
export function getAiQuotaLimits(): AiQuotaLimits {
  return {
    monthlyCallLimit: serverEnv.aiMonthlyCallLimit,
    monthlyCostLimitMinor: serverEnv.aiMonthlyCostLimitMinor,
    perMinuteLimit: serverEnv.aiRateLimitPerMinute,
  };
}

/**
 * AI 调用用例（AI-003）。
 *
 * 返回类型显式写成用例类：`InvokeAiProviderUseCase` 是本仓库对 AI 调用的**唯一**
 * 入口，路由与 AI-004~006 的用例都经它发起调用——门禁、预检、记账、日志四条
 * 横切逻辑因此只有一份实现。
 */
export function getInvokeAiProviderUseCase(): InvokeAiProviderUseCase {
  const repositories = getRepositories();
  return new InvokeAiProviderUseCase({
    provider: getAiProvider(),
    usage: repositories.aiUsage,
    logger: createLogger(),
    now: () => new Date(),
    timeoutMs: serverEnv.aiTimeoutMs,
    limits: getAiQuotaLimits(),
    // 失败入账要写 `ai_usage.model`（非空），而失败时拿不到结果里的模型名，
    // 故用配置态模型名兜底（与 `AI-003` 的既有口径一致）。
    model: serverEnv.aiModel ?? MOCK_AI_PROVIDER,
  });
}

/** AI 草稿生成用例（AI-004/005/006）。 */
export function getGenerateAiDraftUseCase(): GenerateAiDraftUseCase {
  const repositories = getRepositories();
  return new GenerateAiDraftUseCase({
    invoke: getInvokeAiProviderUseCase(),
    drafts: repositories.aiDrafts,
    users: repositories.users,
    tasks: repositories.tasks,
    reviewFacts: repositories.reviewFacts,
    expenses: repositories.expenses,
    now: () => new Date(),
    maxInputChars: serverEnv.aiMaxInputChars,
  });
}

/**
 * AI 草稿确认 / 取消用例（AI-004/005/006）。
 *
 * 三个既有业务用例在这里就地装配：确认必须经它们写入正式数据（§11），
 * 而它们各自的仓储依赖已在 {@link getRepositories} 里备齐。
 */
export function getConfirmAiDraftUseCase(): ConfirmAiDraftUseCase {
  const repositories = getRepositories();
  const audit = getAuditLogger();
  return new ConfirmAiDraftUseCase({
    drafts: repositories.aiDrafts,
    tasks: new ManageTaskUseCase({
      tasks: repositories.tasks,
      goals: repositories.goals,
      actions: repositories.actions,
      lifeAreas: repositories.lifeAreas,
      audit,
    }),
    schedules: new ManageScheduleBlockUseCase({
      blocks: repositories.scheduleBlocks,
      fixed: repositories.fixedCommitments,
      tasks: repositories.tasks,
      audit,
    }),
    expenses: new ManageExpenseUseCase({
      expenses: repositories.expenses,
      expenseCategories: repositories.expenseCategories,
      lifeAreas: repositories.lifeAreas,
      goals: repositories.goals,
      actions: repositories.actions,
      audit,
    }),
    users: repositories.users,
    logger: createLogger(),
    now: () => new Date(),
  });
}

/** AI 用量查询用例（AI-006 的 `GET /ai/usage`）。 */
export function getGetAiUsageUseCase(): GetAiUsageUseCase {
  const repositories = getRepositories();
  return new GetAiUsageUseCase({
    usage: repositories.aiUsage,
    users: repositories.users,
    limits: getAiQuotaLimits(),
    now: () => new Date(),
  });
}

/**
 * 仓储与同步端口集合。
 *
 * 返回类型显式写出来（而不是让 TS 从两个 `create*Repository` 的返回推断）：仓储
 * 的具体类型里带着 Drizzle 的行类型，把它暴露给调用方等于把持久化细节漏出去。
 * 显式标注成领域端口后，**实现替换不会改变调用方的类型**——这正是端口存在的意义。
 *
 * `sync` / `syncApply` / `syncConflicts` 是同步模块的三个端口（读变更、写操作、
 * 冲突记录）。它们与"仓储"同处一个集合，是因为装配方式完全一样（都由
 * `getDatabaseClient()` 的同一个连接池构造），而不是因为它们共享生命周期。
 */
export function getRepositories(): {
  readonly users: UserRepository;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  readonly verificationCodes: VerificationCodeRepository;
  readonly dataExport: ExportReader;
  readonly dataImport: ImportGateway;
  readonly recycle: RecycleRepository;
  readonly deletionRequests: DeletionRequestRepository;
  readonly lifeAreas: LifeAreaRepository;
  readonly expenseCategories: ExpenseCategoryRepository;
  readonly expenses: ExpenseRepository;
  readonly tasks: TaskRepository;
  readonly goals: GoalRepository;
  readonly actions: ActionRepository;
  readonly scheduleBlocks: ScheduleBlockRepository;
  readonly fixedCommitments: FixedCommitmentRepository;
  readonly executionLogs: ExecutionLogRepository;
  readonly recoveryStates: RecoveryStateRepository;
  readonly routines: RoutineRepository;
  readonly notificationRules: NotificationRuleRepository;
  readonly notificationDeliveries: NotificationDeliveryRepository;
  readonly reviews: ReviewRepository;
  readonly reviewFacts: ReviewFactsRepository;
  readonly reviewAdjustments: ReviewAdjustmentApplier;
  readonly sync: SyncRepository;
  readonly syncApply: SyncApplyPort;
  readonly syncConflicts: SyncConflictRepository;
  readonly aiDrafts: AiDraftRepository;
  readonly aiUsage: AiUsageRepository;
} {
  const db = getDatabaseClient().db;
  return {
    users: createUserRepository(db),
    accounts: createAccountRepository(db),
    sessions: createSessionRepository(db),
    verificationCodes: createVerificationCodeRepository(db),
    dataExport: createExportReader(db),
    dataImport: createImportGateway(db),
    recycle: createRecycleRepository(db),
    deletionRequests: createDeletionRequestRepository(db),
    lifeAreas: createLifeAreaRepository(db),
    expenseCategories: createExpenseCategoryRepository(db),
    expenses: createExpenseRepository(db),
    tasks: createTaskRepository(db),
    goals: createGoalRepository(db),
    actions: createActionRepository(db),
    scheduleBlocks: createScheduleBlockRepository(db),
    fixedCommitments: createFixedCommitmentRepository(db),
    executionLogs: createExecutionLogRepository(db),
    recoveryStates: createRecoveryStateRepository(db),
    routines: createRoutineRepository(db),
    notificationRules: createNotificationRuleRepository(db),
    notificationDeliveries: createNotificationDeliveryRepository(db),
    reviews: createReviewRepository(db),
    reviewFacts: createReviewFactsRepository(db),
    reviewAdjustments: createReviewAdjustmentApplier(db),
    sync: createSyncRepository(db),
    syncApply: createSyncApplyPort(db),
    syncConflicts: createSyncConflictRepository(db),
    aiDrafts: createAiDraftRepository(db),
    aiUsage: createAiUsageRepository(db),
  };
}

/**
 * 幂等存储单例（TASK-001 / DB §4.15）。
 *
 * 返回的端口类型在 `app/_lib/idempotency.ts`（消费方所有）——组合根在这里做
 * 结构赋值检查，基础设施不必为了满足消费方的接口而反向 import。
 */
export function getIdempotencyStore() {
  return createIdempotencyStore(getDatabaseClient().db);
}

/** 进程退出前关闭连接池（测试与脚本用；route handler 不需要调用）。 */
export async function closeDatabase(): Promise<void> {
  if (databaseClient !== null) {
    await databaseClient.close();
    databaseClient = null;
  }
}
