/**
 * 复盘用例（REVIEW-001~003，《接口文档》§10、SRS FR-060/061/062）。
 *
 * ## 三条口径在这里收口
 *
 * - **窗口按用户时区切**：日＝该日历日，周＝`[weekStart, weekStart+7)`；时区取自
 *   `users.settings.timezone`（接口没有 `timezone` 查询参数，用户的「一周」由设置决定）。
 * - **快照只读存量**：周已结束才物化，物化后**一律返回存量快照**——若返回当场重算的
 *   事实，"写入后不变性"（DB §4.11.2）就被绕过，用户回看历史会看到被此后输入改写的数字。
 * - **记录 + 执行同事务**：调整由 `ReviewAdjustmentApplier` 一次事务落两笔写入，
 *   本用例只负责解析 `reviewId`、校验目标归属并把动作翻译成写入意图。
 */
import { NotFoundError, ValidationError } from '@/shared/errors/app-error.ts';
import { toAnonymousUserId } from '@/shared/telemetry/anonymous-user-id.ts';
import type { AuditEventType, AuditLogger } from '@/shared/telemetry/audit-event.ts';

import type { ExpenseRepository } from '../../expenses/domain/expense-repository.ts';
import type { GoalRepository } from '../../goals/domain/goal-repository.ts';
import type { UserSettings } from '../../identity/domain/user.ts';
import type { UserRepository } from '../../identity/domain/user-repository.ts';
import { addDays, calendarDayOf } from '../../scheduling/domain/zoned-time.ts';
import type { TaskRepository } from '../../tasks/domain/task-repository.ts';
import {
  adjustmentWriteOf,
  isAllowedCombination,
  type AdjustmentAction,
  type AdjustmentPayload,
  type AdjustmentTargetType,
  type ReviewAdjustment,
} from '../domain/review-adjustment.ts';
import { toWeeklyExpenseSummaries } from './review-dto.ts';
import type { DailyReviewUpsertInput, Review } from '../domain/review.ts';
import type {
  DailyFacts,
  ReviewAdjustmentApplier,
  ReviewFactsRepository,
  ReviewRepository,
} from '../domain/review-repository.ts';
import {
  WEEK_LENGTH_DAYS,
  buildWeeklySnapshot,
  hasWeekEnded,
  type WeeklyExpenseSummary,
  type WeeklyFacts,
} from '../domain/weekly-snapshot.ts';

/** 日复盘视图（`review` 为 `null` 表示当日尚未填写，但事实摘要仍可展示）。 */
export interface DailyReviewView {
  readonly review: Review | null;
  readonly facts: DailyFacts;
}

/** 周复盘视图（`review` 为 `null` 只可能出现在「周未结束且尚无该周行」）。 */
export interface WeeklyReviewView {
  readonly review: Review | null;
  readonly facts: WeeklyFacts;
  readonly expenseSummaries: readonly WeeklyExpenseSummary[];
  /** 本周已确认的调整清单（B2 第 7 项，只增不删）。 */
  readonly adjustments: readonly ReviewAdjustment[];
}

export interface ManageReviewDependencies {
  readonly reviews: ReviewRepository;
  readonly facts: ReviewFactsRepository;
  readonly adjustments: ReviewAdjustmentApplier;
  readonly users: UserRepository;
  readonly tasks: TaskRepository;
  readonly goals: GoalRepository;
  readonly expenses: ExpenseRepository;
  readonly audit: AuditLogger;
}

export class ManageReviewUseCase {
  readonly #reviews: ReviewRepository;
  readonly #facts: ReviewFactsRepository;
  readonly #adjustments: ReviewAdjustmentApplier;
  readonly #users: UserRepository;
  readonly #tasks: TaskRepository;
  readonly #goals: GoalRepository;
  readonly #expenses: ExpenseRepository;
  readonly #audit: AuditLogger;

  constructor(dependencies: ManageReviewDependencies) {
    this.#reviews = dependencies.reviews;
    this.#facts = dependencies.facts;
    this.#adjustments = dependencies.adjustments;
    this.#users = dependencies.users;
    this.#tasks = dependencies.tasks;
    this.#goals = dependencies.goals;
    this.#expenses = dependencies.expenses;
    this.#audit = dependencies.audit;
  }

  /**
   * 日复盘读取。
   *
   * 返回 `null` 的条件是**既没填写、也没有任何事实**——接口 §10 要求此时 `data` 为
   * `null`（空态），而"有执行记录但还没写复盘"是**有内容**的状态，必须给出事实摘要。
   */
  async getDaily(userId: string, date: string): Promise<DailyReviewView | null> {
    const { timezone } = await this.#settings(userId);
    const facts = await this.#facts.collectDailyFacts(userId, date, timezone);
    const review = await this.#reviews.findDaily(userId, date);

    if (review === null && isEmptyDailyFacts(facts)) {
      return null;
    }
    return { review, facts };
  }

  /** 日复盘 upsert（同日重复保存命中同一行，自增 `version`）。 */
  async upsertDaily(
    userId: string,
    date: string,
    input: DailyReviewUpsertInput,
    requestId?: string,
  ): Promise<Review> {
    const review = await this.#reviews.upsertDaily(userId, date, input);
    this.#record('DATA_UPDATED', userId, requestId);
    return review;
  }

  /**
   * 周复盘读取。
   *
   * 周**已结束**时物化并返回存量快照；周**未结束**时实时计算、不落库。已结束的周
   * 若此前访问过（快照已存在），返回的是存量值——事实部分与开销摘要都取快照内的副本。
   */
  async getWeekly(userId: string, weekStart: string): Promise<WeeklyReviewView> {
    const { timezone } = await this.#settings(userId);
    const facts = await this.#facts.collectWeeklyFacts(userId, {
      weekStart,
      weekEnd: addDays(weekStart, WEEK_LENGTH_DAYS),
      timezone,
    });
    // 窗口末日在用户时区的日历日（分类摘要按 `occurred_on` 过滤，闭区间取 +6 天）。
    const expenseSummaries = await this.#weeklyExpenseSummaries(
      userId,
      weekStart,
      addDays(weekStart, WEEK_LENGTH_DAYS - 1),
    );

    const today = calendarDayOf(new Date(), timezone);
    if (hasWeekEnded(weekStart, today)) {
      const review = await this.#reviews.materializeWeeklySnapshot(
        userId,
        weekStart,
        buildWeeklySnapshot({ weekStart, timezone, facts, expenseSummaries }),
      );
      // 存量优先：快照一旦落库就不再重算，因此事实与摘要都读它。
      const stored = review.snapshot;
      return {
        review,
        facts: stored ?? facts,
        expenseSummaries: stored?.expenseSummaries ?? expenseSummaries,
        adjustments: await this.#reviews.listAdjustments(userId, review.id),
      };
    }

    // 周未结束且尚无该周行时为「无清单」——**不**为了读清单而建行：只有真正做
    // 调整（需要 `review_id`）时才由 `createAdjustment` 建行。
    const review = await this.#reviews.findWeekly(userId, weekStart);
    return {
      review,
      facts,
      expenseSummaries,
      adjustments: review === null ? [] : await this.#reviews.listAdjustments(userId, review.id),
    };
  }

  /**
   * 记录 + 执行一条调整（同一事务），返回入列后的完整清单。
   *
   * 目标归属与版本都从当前行读出：调整是"对此刻的目标动手"，因此乐观并发用读到的
   * `version`——若用户在别处改过该目标，`apply` 会以 409 拒绝，而不是覆盖那次改动。
   */
  async createAdjustment(
    userId: string,
    weekStart: string,
    input: {
      readonly targetType: AdjustmentTargetType;
      readonly targetId: string;
      readonly action: AdjustmentAction;
      readonly payload: AdjustmentPayload;
    },
    requestId?: string,
  ): Promise<readonly ReviewAdjustment[]> {
    if (!isAllowedCombination(input.action, input.targetType)) {
      throw new ValidationError(`动作 ${input.action} 不能作用于 ${input.targetType}`);
    }

    const expectedVersion = await this.#requireTargetVersion(userId, input);
    const write = adjustmentWriteOf(input.action, input.payload, input.targetId);
    const review = await this.#reviews.ensureWeekly(userId, weekStart);

    await this.#adjustments.apply(
      userId,
      {
        reviewId: review.id,
        targetType: input.targetType,
        targetId: input.targetId,
        action: input.action,
        payload: input.payload,
      },
      write,
      expectedVersion,
    );
    this.#record('DATA_UPDATED', userId, requestId);

    return this.#reviews.listAdjustments(userId, review.id);
  }

  /** 目标必须存在且属于当前用户；返回其当前版本供乐观并发使用。 */
  async #requireTargetVersion(
    userId: string,
    input: { readonly targetType: AdjustmentTargetType; readonly targetId: string },
  ): Promise<number> {
    if (input.targetType === 'task') {
      const task = await this.#tasks.findById(userId, input.targetId);
      if (task === null) {
        throw new NotFoundError('调整的任务不存在');
      }
      return task.version;
    }
    const goal = await this.#goals.findById(userId, input.targetId);
    if (goal === null) {
      throw new NotFoundError('调整的目标不存在');
    }
    return goal.version;
  }

  /** 分类开销摘要走既有聚合（UI 规范 B2 第 6 项指定的数据源）。 */
  async #weeklyExpenseSummaries(
    userId: string,
    from: string,
    to: string,
  ): Promise<readonly WeeklyExpenseSummary[]> {
    const summary = await this.#expenses.summarize(userId, { from, to, groupBy: 'category' });
    return toWeeklyExpenseSummaries(summary);
  }

  async #settings(userId: string): Promise<UserSettings> {
    const user = await this.#users.findById(userId);
    if (user === null) {
      // 会话指向的用户不存在＝数据损坏（本地模式不会签发这种会话）。
      throw new NotFoundError('用户不存在');
    }
    return user.settings;
  }

  #record(type: AuditEventType, userId: string, requestId: string | undefined): void {
    this.#audit.record({
      type,
      outcome: 'succeeded',
      anonymousUserId: toAnonymousUserId(userId),
      // 复盘答案与备注属敏感内容，只记事件类型与匿名标识。
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
}

/** 事实摘要是否为空（决定 GET daily 是给 `data: null` 还是给一份"零事实"）。 */
function isEmptyDailyFacts(facts: DailyFacts): boolean {
  return (
    facts.planActual.plannedMinutes === 0 &&
    facts.planActual.actualMinutes === 0 &&
    facts.completedCount === 0 &&
    facts.uncompletedCount === 0
  );
}
